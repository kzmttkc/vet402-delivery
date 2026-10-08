/**
 * For this repository's type check only (the frameworks are not its dependencies): the part of each
 * framework's API the examples use, as each framework documents it. In an app, the framework's own types
 * take the place of these.
 *   @coinbase/agentkit  customActionProvider({ name, description, schema, invoke })
 *   @openai/agents      tool({ name, description, parameters, execute })
 *   ai                  tool({ description, inputSchema, execute })
 */
declare module "@coinbase/agentkit" {
  import type { z } from "zod";
  export function customActionProvider<TWalletProvider = unknown>(actions: {
    name: string;
    description: string;
    schema: z.ZodSchema;
    invoke: ((args: any) => Promise<any>) | ((walletProvider: TWalletProvider, args: any) => Promise<any>);
  }): unknown;
}

declare module "@openai/agents" {
  import type { z } from "zod";
  export function tool<P extends z.ZodObject<z.ZodRawShape>, R>(def: { name: string; description: string; parameters: P; execute: (input: z.infer<P>) => Promise<R> }): unknown;
}

declare module "ai" {
  import type { z } from "zod";
  export function tool<P extends z.ZodObject<z.ZodRawShape>, R>(def: { description: string; inputSchema: P; execute: (input: z.infer<P>) => Promise<R> }): unknown;
}
