/** Benchmark-only gateway shim; it never connects to a real profile. */
import { registerHooks } from 'node:module'
const stub = new URL('./bench-typert-stub.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-typert-protocol') return { url: stub, shortCircuit: true }
    return next(specifier, context)
  },
})
