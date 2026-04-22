/**
 * Authoritative route-to-scope map for the Paperclip API.
 * Any new mutation route added to the server MUST update ROUTE_REQUIREMENTS here,
 * or the route will silently default-allow all authenticated agents.
 */

import type { RequestHandler } from "express";
import { logger } from "./logger.js";

const ENFORCEMENT_ENABLED = process.env.PAPERCLIP_SCOPE_ENFORCEMENT === "true";

interface RouteRequirement {
  method: string;
  pattern: RegExp;
  requiredScope: string;
}

const ROUTE_REQUIREMENTS: RouteRequirement[] = [
  { method: "PATCH",  pattern: /^\/api\/issues\/[^/]+$/,                    requiredScope: "issue:patch" },
  { method: "POST",   pattern: /^\/api\/issues\/[^/]+\/comments$/,           requiredScope: "issue:comment:post" },
  { method: "POST",   pattern: /^\/api\/issues\/[^/]+\/checkout$/,           requiredScope: "issue:checkout" },
  { method: "POST",   pattern: /^\/api\/issues\/[^/]+\/release$/,            requiredScope: "issue:checkout" },
  { method: "POST",   pattern: /^\/api\/companies\/[^/]+\/issues$/,          requiredScope: "issue:create" },
  { method: "PUT",    pattern: /^\/api\/issues\/[^/]+\/documents\/[^/]+$/,   requiredScope: "issue:document:write" },
  { method: "POST",   pattern: /^\/api\/agents\/[^/]+\/wakeup$/,             requiredScope: "agent:wakeup" },
];

export function scopeGuard(): RequestHandler {
  return (req, _res, next) => {
    if (req.actor.type !== "agent") {
      next();
      return;
    }

    const agentScope: string[] = req.actor.scope ?? ["*"];
    if (agentScope.includes("*")) {
      next();
      return;
    }

    const match = ROUTE_REQUIREMENTS.find(
      (r) => r.method === req.method && r.pattern.test(req.path),
    );
    // Route not in table — explicit default-allow (see T6 in AKS-1607 test plan)
    if (!match) {
      next();
      return;
    }

    if (!agentScope.includes(match.requiredScope)) {
      logger.warn(
        {
          agentId: req.actor.agentId,
          method: req.method,
          path: req.path,
          scope_required: match.requiredScope,
          scope_provided: agentScope,
        },
        "scope_guard: insufficient scope",
      );

      if (ENFORCEMENT_ENABLED) {
        const err = Object.assign(new Error(`Insufficient scope: ${match.requiredScope} required`), {
          status: 403,
          expose: true,
        });
        next(err);
        return;
      }
    } else {
      // AC-3: logger.info (not .debug) so scope_used events survive prod log levels
      // during the report-only measurement window. Downgrade to debug after
      // the CIS v8 Control 6 narrowing pass when the usage matrix is complete.
      logger.info(
        {
          agentId: req.actor.agentId,
          method: req.method,
          path: req.path,
          scope_required: match.requiredScope,
          scope_provided: agentScope,
        },
        "scope_used",
      );
    }
    next();
  };
}
