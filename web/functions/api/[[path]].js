// Pages Function: forwards /api/* to the Floss Worker through a Service Binding.
// Dashboard: Pages project -> Settings -> Bindings -> Add -> Service binding
//   Variable name: FLOSS_API    Service: floss
// Same-origin calls mean no CORS and no Worker URL baked into the frontend.
export async function onRequest({ request, env }) {
  if (!env.FLOSS_API) {
    return new Response(JSON.stringify({ error: "FLOSS_API service binding is not configured on this Pages project." }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  const url = new URL(request.url);
  return env.FLOSS_API.fetch(new Request(`https://floss.internal${url.pathname}${url.search}`, request));
}
