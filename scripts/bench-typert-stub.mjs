export class TypertRemoteService {
  constructor(ctx) { ctx.remote = this }
}
export function Remote() { return () => {} }
