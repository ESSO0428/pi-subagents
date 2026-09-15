/**
 * pi-ai.ts — single import point for the two test helpers that pi-ai ≥0.80
 * exports only from the `/compat` subpath (both lived on the package root in
 * ≤0.75.x). The current faux test provider is registered with Pi's
 * ModelRuntime instead of the removed ModelRegistry auth shim.
 */
export { fauxProvider } from "@earendil-works/pi-ai";
export { getModel } from "@earendil-works/pi-ai/compat";
