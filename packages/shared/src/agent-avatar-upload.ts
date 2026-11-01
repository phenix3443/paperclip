import { z } from "zod";

export const MAX_AGENT_AVATAR_BYTES = 512 * 1024;
/** Raw PNG/JPEG/WebP bytes, not a URL or a data URL. Null restores the Paperclip character. */
export const setAgentAvatarSchema = z.object({
  imageBase64: z.string().min(4).max(4 * Math.ceil(MAX_AGENT_AVATAR_BYTES / 3))
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
    .nullable(),
}).strict();
export type SetAgentAvatarInput = z.infer<typeof setAgentAvatarSchema>;
/** Converted with this package's zod; see createProjectToolInputJsonSchema. */
export function setAgentAvatarInputJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(setAgentAvatarSchema) as Record<string, unknown>;
}
