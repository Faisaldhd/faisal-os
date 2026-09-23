/**
 * Contract between the Faisal AI agent's three parts:
 *  - groq.ts   runs the model and the tool-calling loop (OpenAI-compatible function calling);
 *  - tools.ts  defines the system tools and executes them against the app's SystemAPI;
 *  - index.ts  shows tool activity and asks the user to confirm anything that changes the system.
 */

/** JSON Schema for a tool's arguments (an object schema). */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string; enum?: string[]; items?: { type: string } }>;
  required?: string[];
  additionalProperties?: boolean;
}

/** A function the model may call, sent to the API as {type:'function', function:{...}}. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** One function call requested by the model; `arguments` is the raw JSON string. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** What the UI shows for a call, and whether it needs the user's OK first. */
export interface ToolPreview {
  /** Short line for the activity log, e.g. "Reading /home/user/notes.txt". */
  label: string;
  /** Set when the call changes the system: shown in the confirmation card. */
  confirm?: { title: string; detail: string; danger: boolean };
}

/** Asks the user; resolves true to run the call. */
export type ConfirmFn = (request: NonNullable<ToolPreview['confirm']>) => Promise<boolean>;

/** The system tools, bound to one app session. */
export interface ToolBox {
  specs: ToolSpec[];
  /** Pure description of a call (bad JSON gives a generic label, never throws). */
  preview(call: ToolCall): ToolPreview;
  /**
   * Runs a call and returns the text sent back to the model. Never throws: errors,
   * refusals and denied confirmations come back as text the model can react to.
   */
  execute(call: ToolCall, confirm: ConfirmFn): Promise<string>;
}

/** Hooks the tool-calling loop uses; all optional so plain chat keeps working. */
export interface AgentOptions {
  tools: ToolBox;
  confirm: ConfirmFn;
  /** Called before a call runs (after the model finished requesting it). */
  onCall?(call: ToolCall, preview: ToolPreview): void;
  /** Called with the result text the model will see. */
  onResult?(call: ToolCall, result: string): void;
  /** Safety cap on model ↔ tool round trips in one user turn (default 8). */
  maxSteps?: number;
}
