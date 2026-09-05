/**
 * `actor/index.ts` -- the public surface of M2.18 (brief §4). M3.1 wires
 * `resolveActor` in; nothing beyond this list is public.
 */

export { ActorErrorCodes } from "./errors";
export type {
  Actor,
  ActorSource,
  ParentSource,
  ResolveActorOptions,
  ResolvedActor,
} from "./resolve";
export { formatActor, parseActor, resolveActor } from "./resolve";
