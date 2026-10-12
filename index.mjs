// The finite export hook and the explicitly launched MCP service are separate.
// Career-Ops has no server hook; enabling this plugin never starts a service.
export default {
  async export(snapshot, ctx) {
    const summary = {
      schema_version: 1,
      snapshot_at: new Date().toISOString(),
      applications: snapshot?.applications?.length ?? 0,
      inbox: snapshot?.pipeline?.length ?? 0,
      permissions: { read: true, write: false, network: false },
    };
    if (ctx.dryRun) ctx.log('Would export local workspace counts; no files or network are used.');
    else ctx.log(JSON.stringify(summary));
    return { pushed: 0 }; // No external store or tracker write.
  },
};
