import type { Settings } from './settings';

/** Who is asking, on whose behalf, and which access groups they may read. */
export interface Caller {
  clientId?: string;
  /** True when the client acts for end users (gateway). */
  delegated?: boolean;
  scopes: string[];
  /** Effective access groups: token ceiling, optionally narrowed per request. Empty in open mode. */
  accessGroups: string[];
  onBehalfOf?: string;
  agentId?: string;
  runId?: string;
  traceId?: string;
}

export type Capability = 'retrieve' | 'ask';

export class AccessError extends Error {
  constructor(
    public readonly statusCode: 400 | 403,
    message: string,
  ) {
    super(message);
  }
}

const GROUP_SCOPE = 'group:';
const ID_PATTERN = /^[A-Za-z0-9._:@\-/]{1,128}$/;
const GROUP_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * Identity passthrough contract (set by the gateway or calling agent):
 *   X-On-Behalf-Of   opaque end-user id, recorded in the audit trail
 *   X-Access-Groups  comma-separated groups to NARROW to (never widens the token)
 *   X-Agent-Id, X-Run-Id, X-Trace-Id  correlation ids (audit, Langfuse)
 */
export function resolveCaller(claims: Record<string, unknown> | undefined, headers: Record<string, string | undefined> | null, settings: Settings): Caller {
  const h = lowerCase(headers ?? {});
  const scopes = typeof claims?.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [];
  const groupPrefix = `${settings.scopePrefix}/${GROUP_SCOPE}`;
  const ceiling = scopes.filter((s) => s.startsWith(groupPrefix)).map((s) => s.slice(groupPrefix.length));

  const delegated = scopes.includes(`${settings.scopePrefix}/delegated`);
  if (delegated && (!h['x-on-behalf-of'] || (settings.access.mode === 'groups' && !h['x-access-groups']))) {
    // A gateway token must always say who it acts for and narrow to their groups.
    throw new AccessError(400, 'Delegating clients must send X-On-Behalf-Of and X-Access-Groups');
  }

  let accessGroups: string[] = [];
  if (settings.access.mode === 'groups') {
    accessGroups = ceiling;
    const requested = h['x-access-groups'];
    if (requested !== undefined) {
      const narrowed = requested
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);
      if (narrowed.length === 0 || narrowed.length > 50 || !narrowed.every((g) => GROUP_PATTERN.test(g))) {
        throw new AccessError(400, 'X-Access-Groups must be a comma-separated list of group names');
      }
      // Intersection only: a caller can never gain a group its token lacks.
      accessGroups = ceiling.filter((g) => narrowed.includes(g));
    }
    if (accessGroups.length === 0) throw new AccessError(403, 'Forbidden');
  }

  return {
    clientId: typeof claims?.client_id === 'string' ? claims.client_id : undefined,
    delegated,
    scopes,
    accessGroups,
    onBehalfOf: optionalId(h, 'x-on-behalf-of'),
    agentId: optionalId(h, 'x-agent-id'),
    runId: optionalId(h, 'x-run-id'),
    traceId: optionalId(h, 'x-trace-id'),
  };
}

export function can(caller: Caller, capability: Capability, settings: Settings): boolean {
  return caller.scopes.includes(`${settings.scopePrefix}/${capability}`);
}

function optionalId(h: Record<string, string | undefined>, name: string): string | undefined {
  const v = h[name];
  if (v === undefined || v === '') return undefined;
  if (!ID_PATTERN.test(v)) throw new AccessError(400, `${name} has an invalid format`);
  return v;
}

function lowerCase(headers: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}
