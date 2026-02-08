/**
 * Route: /.well-known/agent-card.json
 *
 * Serves an agent card that advertises the agent's x402 payment capabilities,
 * wallet address, network, and available paid skills/routes.
 */

import type {
  IAgentRuntime,
  Route,
  RouteRequest,
  RouteResponse,
} from "@elizaos/core";

import { X402Service } from "../services/x402-service";
import { resolveNetwork } from "../networks";

/** Shape of a skill entry in the agent card */
interface AgentCardSkill {
  name: string;
  description: string;
  path?: string;
  price?: string;
  network?: string;
}

/** Shape of the agent card JSON response */
interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  capabilities: {
    x402Payments: boolean;
  };
  payments: Array<{
    method: string;
    payee: string;
    network: string;
    facilitatorUrl: string;
  }>;
  skills: AgentCardSkill[];
}

/** GET /.well-known/agent-card.json — Serve the agent's payment capabilities card */
async function handleAgentCard(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const service = runtime.getService<X402Service>("x402_payment");
  if (!service || !service.isActive()) {
    res.status(503).json({ error: "x402 service not active" });
    return;
  }

  const walletAddress = service.getWalletAddress() ?? "";
  const networkKey = service.getNetwork();
  const facilitatorUrl = service.getFacilitatorUrl();

  // Resolve CAIP-2 network identifier
  let caip2Network: string;
  try {
    const networkInfo = resolveNetwork(networkKey);
    caip2Network = networkInfo.caip2;
  } catch {
    caip2Network = networkKey;
  }

  // Extract agent name and description from runtime character
  const character = runtime.character;
  const agentName = character?.name ?? "ElizaOS Agent";
  const agentDescription =
    (Array.isArray(character?.bio) ? character.bio[0] : character?.bio) ??
    "An ElizaOS agent with x402 payment capabilities";

  // Auto-detect the agent URL from the request or configuration
  const configuredUrl = String(runtime.getSetting("X402_AGENT_URL") ?? "");
  let agentUrl = configuredUrl;
  if (!agentUrl && req.headers) {
    const host =
      (Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host) ?? "";
    const proto =
      (Array.isArray(req.headers["x-forwarded-proto"])
        ? req.headers["x-forwarded-proto"][0]
        : req.headers["x-forwarded-proto"]) ?? "https";
    if (host) {
      agentUrl = `${proto}://${host}`;
    }
  }

  // Collect paid routes/skills from the plugin's routes
  const skills: AgentCardSkill[] = [];

  // Check registered routes for x402 configuration
  const plugins = runtime.plugins ?? [];
  for (const plugin of plugins) {
    if (!plugin.routes) continue;
    for (const route of plugin.routes) {
      // Access x402 field — it's on BaseRoute but may not be in published types yet
      const x402Config = "x402" in route
        ? (route as { x402?: { price: string; network?: string; description?: string } }).x402
        : undefined;
      if (x402Config) {
        skills.push({
          name: ("name" in route ? route.name : undefined) ?? route.path,
          description: x402Config.description ?? `Paid endpoint: ${route.path}`,
          path: route.path,
          price: x402Config.price,
          network: x402Config.network,
        });
      }
    }
  }

  const card: AgentCard = {
    protocolVersion: "1.0",
    name: agentName,
    description: agentDescription,
    url: agentUrl,
    capabilities: {
      x402Payments: true,
    },
    payments: [
      {
        method: "x402",
        payee: walletAddress,
        network: caip2Network,
        facilitatorUrl,
      },
    ],
    skills,
  };

  res.status(200).json(card as unknown as Record<string, string | number | boolean | Record<string, string> | undefined>);
}

export const agentCardRoute: Route = {
  type: "GET" as const,
  path: "/.well-known/agent-card.json",
  name: "x402-agent-card",
  public: true,
  handler: handleAgentCard,
};
