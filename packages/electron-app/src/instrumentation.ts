export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initGatewayAutoStart } = await import('./lib/gateway-manager');
    await initGatewayAutoStart();
  }
}
