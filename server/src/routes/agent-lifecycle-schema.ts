import { z } from "zod";

// Keep this server-local copy aligned with
// packages/shared/src/validators/agent.ts. The route cannot depend on the
// shared package's broad validator module during a narrow server deployment.
export const agentLifecycleActionSchema = z.object({
  repository: z.string().trim().min(1),
  approvedStage: z.string().trim().min(1),
  taskId: z.string().uuid(),
}).strict();
