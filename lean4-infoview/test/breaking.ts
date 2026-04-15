/**
 * Tests for breaking changes in the local state of the infoview API
 * (meaning anything exported from `src/index.tsx`)
 * relative to the latest published NPM release of `@leanprover/infoview`.
 * It does so by turning both packages into records in the TypeScript type system
 * and checking that one extends the other.
 *
 * If this file fails to typecheck,
 * then either there was a breaking change
 * or it is a false positive.
 * In case of such a failure, the procedure is:
 * 1. Ensure that `CheckSelfCompatible` below does not have errors.
 *    If it does, the test itself is broken and needs to be fixed.
 * 2. Inspect the error on `CheckNoBreakingChanges`
 *    to determine the change that caused it
 *    and decide whether it actually is breaking or not.
 *    If you are not sure, the conservative choice is to assume it's breaking.
 * 3. Bump the major (if breaking) or minor/patch (otherwise) version
 *    of the package in `lean4-infoview/package.json`.
 * 4. After finalizing your changes (e.g. after a round of PR reviews),
 *    publish the new release on NPM.
 * 5. Point the `current-release` dependency at the new NPM release.
 *    Rerun the test to ensure it now typechecks.
 *
 * @module
 */

/**
 * Recursively transform any type into a structural form suitable for testing compatibility
 * of public interfaces. For example, `private` fields are forgotten. In
 * ```typescript
 * declare class Foo { private x: number; y: number }
 * declare class Bar { private x: number; y: number }
 * ```
 * it is not true that `typeof Foo extends typeof Bar` since the `private` fields are considered
 * distinct by the type system. However the public interfaces are the same so
 * `typeof Foo extends Recordify<typeof Bar>` is true.
 */
type Recordify<T> =
    // Avoid distributing over `any` as a union:
    // https://www.typescriptlang.org/docs/handbook/2/conditional-types.html#distributive-conditional-types
    [T] extends [number]
        ? T
        : T extends string
          ? T
          : T extends boolean
            ? T
            : T extends bigint
              ? T
              : T extends symbol
                ? T
                : T extends undefined
                  ? T
                  : T extends null
                    ? T
                    : T extends Promise<infer U>
                      ? Promise<Recordify<U>>
                      : T extends (...args: infer As) => infer R
                        ? (..._: Recordify<As>) => Recordify<R>
                        : T extends abstract new (...args: infer As) => infer R
                          ? new (..._: Recordify<As>) => Recordify<R>
                          : { [P in keyof T]: Recordify<T[P]> }

/** Compile-time error unless the first type extends the second. */
type CheckExtends<T extends F, F> = never

// Sanity checks
type CheckAny = CheckExtends<any, Recordify<any>>
type CheckNumber = CheckExtends<number, Recordify<number>>
type CheckString = CheckExtends<string, Recordify<string>>
type CheckBoolean = CheckExtends<boolean, Recordify<boolean>>
type CheckPromise<T> = CheckExtends<Promise<Recordify<T>>, Recordify<Promise<T>>>
type CheckArray<T> = CheckExtends<Recordify<T>[], Recordify<T[]>>
declare class Foo {
    private x: number
}
declare class Bar {
    private x: number
}
type CheckPrivate = CheckExtends<typeof Foo, Recordify<typeof Bar>>
declare class Baz extends Bar {
    y: number
}
type CheckCovariant = CheckExtends<(_: any) => Baz, Recordify<(_: any) => Bar>>
type CheckContravariant = CheckExtends<Recordify<(_: Bar) => any>, (_: Baz) => any>

type CurrentRelease = typeof import('current-release')
type NextRelease = typeof import('../src/index')

/**
 * Ensures that the test isn't broken. The codebase should always be compatible with itself.
 * `CheckExtends` is always `never`: the check is its type constraint. Thus both union members
 * are `never`, and the lint rules about redundant union members do not apply.
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-duplicate-type-constituents */
type CheckSelfCompatible =
    | CheckExtends<Recordify<Pick<CurrentRelease, keyof CurrentRelease>>, Recordify<CurrentRelease>>
    | CheckExtends<Recordify<Pick<NextRelease, keyof NextRelease>>, Recordify<NextRelease>>
/* eslint-enable @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-duplicate-type-constituents */

/**
 * Compile-time error if the current version makes any breaking changes relative to the latest release.
 * Otherwise this should typecheck. The printed error may be somewhat inscrutable but should point
 * at the source of incompatibility.
 * From https://stackoverflow.com/a/71618156
 * and https://lostintime.dev/2021/01/02/typescript-api-breaking-changes.html
 */
type CheckNoBreakingChanges = CheckExtends<
    Recordify<Pick<NextRelease, keyof CurrentRelease>>,
    Recordify<CurrentRelease>
>
