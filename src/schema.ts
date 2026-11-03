// Standard Schema (standardschema.dev): the one interface zod, valibot, arktype and others implement, copied here as
// the spec asks, so a handler can check its input with any of them and the SDK still depends on nothing.

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardProps<Input, Output>;
}

export interface StandardProps<Input = unknown, Output = Input> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
  readonly types?: { readonly input: Input; readonly output: Output } | undefined;
}

export type StandardResult<Output> = { readonly value: Output; readonly issues?: undefined } | { readonly issues: ReadonlyArray<StandardIssue> };

export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

export type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['input'];
export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['output'];

/** The value the schema makes of `input`, or an error that says every place it does not match. */
export async function validated<Output>(schema: StandardSchemaV1<unknown, Output>, input: unknown): Promise<Output> {
  const result = await schema['~standard'].validate(input);
  if (result.issues === undefined) return result.value;
  const where = (issue: StandardIssue): string => (issue.path?.length ? `${issue.path.map((part) => String(typeof part === 'object' ? part.key : part)).join('.')}: ` : '');
  throw new Error(`The input does not match: ${result.issues.map((issue) => `${where(issue)}${issue.message}`).join('; ')}`);
}
