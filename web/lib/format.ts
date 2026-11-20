// Words for numbers, times, and the server's error codes.

import { ApiError } from "./api.ts";

export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const seconds = (Date.now() - Date.parse(iso)) / 1_000;
  if (seconds < 45) return "just now";
  if (seconds < 3_600) return `${Math.max(1, Math.round(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  if (seconds < 30 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export const exactTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "1:07" for a duration in milliseconds. */
export function elapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function tokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 100_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

export function bytes(count: number): string {
  if (count < 1_024) return `${count} B`;
  if (count < 1_024 * 1_024) return `${(count / 1_024).toFixed(count < 10_240 ? 1 : 0)} KB`;
  return `${(count / (1_024 * 1_024)).toFixed(1)} MB`;
}

export function money(amount: number): string {
  if (amount === 0) return "$0";
  return amount < 0.01 ? "<$0.01" : `$${amount.toFixed(2)}`;
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const MESSAGES: Record<string, string> = {
  unauthenticated: "Your session has ended. Sign in again.",
  owner_required: "Only the installation owner can do that.",
  invalid_origin: "This page was opened from an address the server does not accept. Use the forum's own address.",
  invalid_input: "The server did not accept that input.",
  invalid_or_expired_link: "That sign-in link is invalid, already used, or expired.",
  invalid_or_expired_invite: "That project invitation is invalid, already used, or expired.",
  handle_required: "Choose a handle to join this project.",
  project_not_found: "That project does not exist, or you are not a member of it.",
  project_name_conflict: "A project with that name already exists.",
  subforum_name_conflict: "A subforum with that name already exists in this project.",
  subforum_not_found: "That subforum is not available in this project.",
  thread_not_found: "That thread does not exist in this project.",
  handle_conflict: "That handle is taken.",
  already_a_member: "Already a member of this project.",
  source_locator_conflict: "This project already has a source with that locator.",
  credential_name_conflict: "That agent already has a credential with that name.",
  conversation_busy: "The Scribe is already replying in this conversation.",
  scribe_model_not_configured: "The owner has not configured a model for this project's Scribe yet.",
  sandbox_not_running: "The project sandbox is not running. Start it on the Workspace page.",
  sandbox_not_created: "The project sandbox has not been started yet.",
  sandbox_preview_unavailable: "The sandbox preview is not answering yet.",
  sandbox_image_outdated: "The sandbox image is out of date. Run npm run sandbox:build, then try again.",
  scribe_returned_no_text: "The Scribe finished without writing a reply.",
  tool_call_limit_reached: "The Scribe reached its tool-call limit for one reply.",
  model_step_limit_reached: "The Scribe reached its step limit for one reply.",
  output_token_limit_reached: "The Scribe reached its output limit for one reply.",
  chatgpt_not_connected: "Connect ChatGPT under Agents → Model access, then try again.",
  chatgpt_sign_in_expired: "The ChatGPT connection has expired. Connect it again under Agents → Model access.",
  claude_code_ended_without_a_result: "Claude Code ended without returning a reply.",
  claude_code_did_not_answer: "Claude Code did not answer. Make sure it is installed and signed in on this computer.",
  model_api_key_not_stored: "That provider does not have an Autoforum-stored API key.",
  model_api_key_provider_not_supported: "That provider does not support a simple API key. Configure it on the host instead.",
  model_api_key_provider_requires_additional_setup: "That provider needs more than one API key field. Configure it on the host instead.",
  model_api_key_save_failed: "Autoforum could not save that API key.",
  model_api_key_remove_failed: "Autoforum could not remove that API key.",
  scribe_stopped: "The Scribe was stopped.",
  duplicate_local_key: "Two attachments share the same key.",
  reply_not_found: "The post being replied to is not in this thread.",
  tree_too_large: "The workspace has too many files to list.",
  file_too_large: "That file is too large to show here. Download it instead.",
  source_redirect_limit: "The source redirected too many times.",
  source_upload_too_large: "That file is too large. PDFs may be up to 20 MB and text files up to 2 MB.",
  source_upload_empty: "That file is empty.",
  source_upload_not_utf8: "Text source uploads must use UTF-8.",
  source_content_type_not_supported: "Upload a text-bearing PDF or a UTF-8 text file.",
  source_pdf_page_limit: "That PDF has too many pages to read safely.",
  source_pdf_text_unavailable: "Autoforum could not extract text from that PDF.",
  interrupted_by_restart: "Interrupted when the server restarted.",
};

const PREFIXES: Array<[string, (rest: string) => string]> = [
  ["address_not_found:", (rest) => `There is no ${rest} in this project.`],
  ["invalid_reference:", (rest) => `[[${rest}]] is not a valid address.`],
  ["unknown_local_reference:", (rest) => `[[new:${rest}]] does not match an attachment on this post.`],
  ["model_not_found:", (rest) => `No model ${rest} is available. Check the provider and model id.`],
  ["project_agent_turn_limit_below_admitted:", (rest) => `The project allowance cannot be lower than the ${rest} agent turns already admitted.`],
  ["chatgpt_auth:", (rest) => `ChatGPT sign-in failed: ${rest.replace(/_/g, " ")}.`],
  ["claude_code_not_signed_in:", () => "Claude Code is not signed in. Run `claude` in a terminal on this computer and use /login."],
  ["source_not_found:", (rest) => `There is no ${rest} in this project.`],
  ["invalid_source:", (rest) => `${rest} is not a source address.`],
  ["object_body_required:", (rest) => `The attachment "${rest}" needs text.`],
  ["invalid_relation:", (rest) => `The relation "${rest}" needs a type, a subject, and an object.`],
  ["duplicate_relation_endpoint:", (rest) => `The relation "${rest}" lists the same address twice.`],
];

/** A sentence for whatever went wrong. Unknown codes are shown as written, underscores removed. */
export function describeError(error: unknown): string {
  const code = error instanceof ApiError ? error.code : error instanceof Error ? error.message : String(error);
  if (MESSAGES[code]) return MESSAGES[code];
  for (const [prefix, describe] of PREFIXES) if (code.startsWith(prefix)) return describe(code.slice(prefix.length));
  if (code === "Failed to fetch" || code.startsWith("NetworkError")) return "The server could not be reached.";
  const readable = code.replace(/_/g, " ").trim();
  return readable ? readable[0]!.toUpperCase() + readable.slice(1) : "Something went wrong.";
}
