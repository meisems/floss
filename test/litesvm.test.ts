/**
 * Runs the real SweepEngine against LiteSVM: an in-process Solana runtime executing the actual
 * SPL Token, Token-2022 and Associated Token programs. Proves the instructions Floss builds
 * (revoke, harvest, close, ATA create, transferChecked, sweep, tip) execute on chain and that the
 * wallet ends on the exact lamport the plan promised.
 */
import { beforeAll, describe, expect, it } from "vitest";
// litesvm ships native binaries for Linux and macOS only; on other platforms the suite is skipped
// (CI runs it on ubuntu-latest).
let litesvm: typeof import("litesvm") | null = null;
try {
  litesvm = await import("litesvm");
} catch {
  litesvm = null;
}
type LiteSVM = import("litesvm").LiteSVM;
const isFailed = (r: unknown): r is import("litesvm").FailedTransactionMetadata => litesvm !== null && r instanceof litesvm.FailedTransactionMetadata;
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64Encoder,
  getTransactionDecoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getApproveInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  getInitializeMint2Instruction as getInitializeMint2Instruction2022,
  getInitializeTransferFeeConfigInstruction,
  getMintToInstruction as getMintToInstruction2022,
  getTokenDecoder,
  getTransferCheckedInstruction as getTransferCheckedInstruction2022,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { SweepEngine, type FlossRequest } from "../src/engine/SweepEngine.ts";
import { runtimeConfig } from "../src/config.ts";
import type { ParsedTokenAccount, SolanaRpc } from "../src/solana/rpc.ts";
import type { JitoClient } from "../src/solana/jito.ts";
import { testEnv } from "./helpers.ts";

const SOL = 1_000_000_000n;
const TIP_ACCOUNT = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";

let svm: LiteSVM;
let funder: KeyPairSigner;
let session: KeyPairSigner;
let vault: string;

function send(feePayer: KeyPairSigner, ixs: Instruction[]) {
  return (async () => {
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000n }, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    const tx = await signTransactionMessageWithSigners(msg);
    const res = svm.sendTransaction(tx);
    if (isFailed(res)) throw new Error(`setup tx failed: ${res.toString()}\n${res.meta().logs().join("\n")}`);
    svm.expireBlockhash();
  })();
}

async function createMint(program: Address, decimals: number, extraIxs: (mint: Address) => Instruction[] = () => [], space = 82): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const rent = svm.minimumBalanceForRentExemption(BigInt(space));
  const init =
    program === TOKEN_PROGRAM_ADDRESS
      ? getInitializeMint2Instruction({ mint: mint.address, decimals, mintAuthority: funder.address })
      : getInitializeMint2Instruction2022({ mint: mint.address, decimals, mintAuthority: funder.address });
  await send(funder, [
    getCreateAccountInstruction({ payer: funder, newAccount: mint, lamports: rent, space, programAddress: program }),
    ...extraIxs(mint.address),
    init,
  ]);
  return mint.address;
}

async function ata(owner: Address, mint: Address, program: Address): Promise<Address> {
  const [a] = await findAssociatedTokenPda({ owner, mint, tokenProgram: program });
  await send(funder, [getCreateAssociatedTokenIdempotentInstruction({ payer: funder, ata: a, owner, mint, tokenProgram: program })]);
  return a;
}

function readToken(addr: string) {
  const acc = svm.getAccount(address(addr));
  if (!acc.exists) return null;
  return getTokenDecoder().decode(acc.data);
}

/** SolanaRpc facade over LiteSVM: same calls the engine makes against a real node. */
function svmRpc(): SolanaRpc {
  const parse = (pubkey: string, programId: string, lamports_: bigint, data: Uint8Array): ParsedTokenAccount | null => {
    if (data.length < 165 || (data.length > 165 && data[165] !== 2)) return null; // skip mints
    const t = getTokenDecoder().decode(data);
    const exts = t.extensions.__option === "Some" ? t.extensions.value : [];
    const fee = exts.find((e) => e.__kind === "TransferFeeAmount") as { withheldAmount: bigint } | undefined;
    const kindName = (k: string) => k.charAt(0).toLowerCase() + k.slice(1);
    return {
      pubkey,
      programId,
      lamports: lamports_,
      mint: t.mint,
      owner: t.owner,
      amount: t.amount,
      decimals: 6,
      state: t.state === 2 ? "frozen" : "initialized",
      isNative: t.isNative.__option === "Some",
      delegate: t.delegate.__option === "Some" ? t.delegate.value : null,
      delegatedAmount: t.delegatedAmount,
      closeAuthority: t.closeAuthority.__option === "Some" ? t.closeAuthority.value : null,
      withheldAmount: fee?.withheldAmount ?? 0n,
      extensions: exts.map((e) => kindName(e.__kind)),
    };
  };
  const decodeWire = (b64: string) => getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(b64)));
  let n = 0;
  return {
    isHelius: false,
    async getAccountOwner(a: string) {
      const acc = svm.getAccount(address(a));
      return acc.exists ? { owner: acc.programAddress, lamports: acc.lamports, executable: false, dataLength: acc.data.length } : null;
    },
    async getBalance(a: string) {
      return svm.getBalance(address(a)) ?? 0n;
    },
    async getTokenAccounts(owner: string) {
      const out: ParsedTokenAccount[] = [];
      for (const program of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
        for (const acc of svm.getProgramAccounts(program)) {
          const p = parse(acc.address, program, acc.lamports, new Uint8Array(acc.data));
          if (p && p.owner === owner) out.push(p);
        }
      }
      return out;
    },
    async getMinimumBalanceForRentExemption(size: number) {
      return svm.minimumBalanceForRentExemption(BigInt(size));
    },
    async getLatestBlockhash() {
      return { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000n };
    },
    async getPriorityFeeMicroLamports() {
      return 1_000n;
    },
    async simulate(b64: string) {
      const res = svm.simulateTransaction(decodeWire(b64));
      if (isFailed(res)) return { err: res.err(), logs: res.meta().logs(), unitsConsumed: null, accounts: null, innerInstructions: null };
      return { err: null, logs: res.meta().logs(), unitsConsumed: Number(res.meta().computeUnitsConsumed()), accounts: null, innerInstructions: null };
    },
    async sendTransaction(b64: string) {
      const res = svm.sendTransaction(decodeWire(b64));
      if (isFailed(res)) throw new Error(`send failed: ${res.toString()}\n${res.meta().logs().join("\n")}`);
      svm.expireBlockhash();
      return `sig${n++}`;
    },
    async getSignatureStatuses(sigs: string[]) {
      return sigs.map(() => ({ confirmationStatus: "confirmed" as const, err: null }));
    },
    async getBlockHeight() {
      return 0n;
    },
  } as unknown as SolanaRpc;
}

function svmJito(rpc: SolanaRpc): JitoClient {
  return {
    async pickTipAccount() {
      return TIP_ACCOUNT;
    },
    async chooseTip() {
      return 10_000n;
    },
    async sendBundle(txs: string[]) {
      for (const t of txs) await rpc.sendTransaction(t);
      return "bundle";
    },
  } as unknown as JitoClient;
}

describe.skipIf(litesvm === null)("SweepEngine on LiteSVM (real token programs)", () => {
  let accA: Address; // classic, balance 1000, delegated -> revoke (profit) / evacuate (full)
  let accB: Address; // classic, empty -> close
  let accC: Address; // Token-2022 w/ 1% fee, empty but withheld fees -> harvest + close
  let mintA: Address;

  beforeAll(async () => {
    svm = new litesvm!.LiteSVM().withSigverify(false);
    funder = await generateKeyPairSigner();
    session = await generateKeyPairSigner();
    vault = (await generateKeyPairSigner()).address;
    svm.airdrop(funder.address, lamports(100n * SOL));
    svm.airdrop(session.address, lamports(3n * SOL + 4_321n));
    // Jito tip accounts always exist on mainnet; a fresh LiteSVM has none, and a 10k-lamport tip
    // into a missing account would fail Solana's rent check.
    svm.airdrop(address(TIP_ACCOUNT), lamports(SOL));

    mintA = await createMint(TOKEN_PROGRAM_ADDRESS, 6);
    accA = await ata(session.address, mintA, TOKEN_PROGRAM_ADDRESS);
    await send(funder, [getMintToInstruction({ mint: mintA, token: accA, mintAuthority: funder, amount: 1_000n })]);
    const delegate = (await generateKeyPairSigner()).address;
    await send(session, [getApproveInstruction({ source: accA, delegate, owner: session, amount: 500n })]);

    const mintB = await createMint(TOKEN_PROGRAM_ADDRESS, 6);
    accB = await ata(session.address, mintB, TOKEN_PROGRAM_ADDRESS);

    // Token-2022 mint with a 1% transfer fee (TransferFeeConfig = 108 bytes => 278-byte mint).
    const mintC = await createMint(
      TOKEN_2022_PROGRAM_ADDRESS,
      6,
      (m) => [
        getInitializeTransferFeeConfigInstruction({
          mint: m,
          transferFeeConfigAuthority: funder.address,
          withdrawWithheldAuthority: funder.address,
          transferFeeBasisPoints: 100,
          maximumFee: 1_000_000_000n,
        }),
      ],
      278,
    );
    const funderC = await ata(funder.address, mintC, TOKEN_2022_PROGRAM_ADDRESS);
    accC = await ata(session.address, mintC, TOKEN_2022_PROGRAM_ADDRESS);
    await send(funder, [getMintToInstruction2022({ mint: mintC, token: funderC, mintAuthority: funder, amount: 1_000_000n })]);
    await send(funder, [getTransferCheckedInstruction2022({ source: funderC, mint: mintC, destination: accC, authority: funder, amount: 100_000n, decimals: 6 })]);
    // Session sends its whole balance back: amount 0, but 1,000 withheld fee units stay in accC.
    await send(session, [getTransferCheckedInstruction2022({ source: accC, mint: mintC, destination: funderC, authority: session, amount: 99_000n, decimals: 6 })]);

    const c = readToken(accC)!;
    expect(c.amount).toBe(0n);
    const exts = c.extensions.__option === "Some" ? c.extensions.value : [];
    expect(exts.find((e) => e.__kind === "TransferFeeAmount")).toMatchObject({ withheldAmount: 1_000n });
  }, 60_000);

  const req = (patch: Partial<FlossRequest>): FlossRequest => ({
    mode: "profit",
    evacuateTokens: false,
    keepLamports: 2n * SOL,
    minSweepLamports: 0n,
    urgency: "normal",
    dryRun: false,
    ...patch,
  });

  it("profit floss: revokes, harvests + closes, sweeps to exactly the float", async () => {
    const rpc = svmRpc();
    const engine = new SweepEngine({ rpc, jito: svmJito(rpc), cfg: runtimeConfig(testEnv()) });
    const vaultBefore = svm.getBalance(address(vault)) ?? 0n;
    const rentB = svm.getAccount(accB).exists ? (svm.getAccount(accB) as { lamports: bigint }).lamports : 0n;
    const rentC = svm.getAccount(accC).exists ? (svm.getAccount(accC) as { lamports: bigint }).lamports : 0n;

    const r = await engine.run(session, vault, req({}));

    expect(r.skipped).toEqual([]);
    expect(r.revoked.map((x) => x.account)).toEqual([accA]);
    expect(r.closed.map((x) => x.account).sort()).toEqual([accB, accC].sort());
    expect(r.harvested).toBe(1);
    expect(readToken(accA)?.delegate.__option).toBe("None");
    expect(svm.getAccount(accB).exists).toBe(false);
    expect(svm.getAccount(accC).exists).toBe(false);

    expect(svm.getBalance(session.address)).toBe(2n * SOL);
    expect((svm.getBalance(address(vault)) ?? 0n) - vaultBefore).toBe(r.sweptLamports + rentB + rentC);
    expect(svm.getBalance(address(TIP_ACCOUNT))).toBe(SOL + 10_000n);
  }, 60_000);

  it("full floss with evacuation: tokens land in vault ATAs, wallet ends at 0", async () => {
    const rpc = svmRpc();
    const engine = new SweepEngine({ rpc, jito: svmJito(rpc), cfg: runtimeConfig(testEnv()) });
    const r = await engine.run(session, vault, req({ mode: "full", evacuateTokens: true, keepLamports: 0n, urgency: "high" }));

    const [vaultA] = await findAssociatedTokenPda({ owner: address(vault), mint: mintA, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(readToken(vaultA)?.amount).toBe(1_000n);
    expect(svm.getAccount(accA).exists).toBe(false);
    expect(r.evacuated).toEqual([{ mint: mintA, amount: 1_000n, decimals: 6 }]);
    expect(svm.getBalance(session.address) ?? 0n).toBe(0n);
    expect(r.balanceAfter).toBe(0n);
  }, 60_000);
});
