// Types for changelog-fragments.mjs so the TypeScript suites can import it.

export declare function fragmentNames(dir?: string): string[]

export declare function countFragments(dir?: string): number

export declare function foldFragmentBody(body: string | null | undefined): string

export declare function fragmentBodyProblem(body: string | null | undefined): string | null
