This document serves as documentation for the semantic token contributions in [`package.json`](/vscode-lean4/package.json): `semanticTokenTypes`, `semanticTokenModifiers`, `semanticTokenScopes` and the related `configurationDefaults`.

See [the official VS Code documentation](https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide) for an overview of semantic highlighting.

## How VS Code styles a semantic token

The facts in this section come from the VS Code source code: `getTokenStyle` and `resolveScopes` in `colorThemeData.ts`, `parseTokenSelector` in `tokenClassificationRegistry.ts` and `addSparseTokens` in `sparseTokensStore.ts`.

VS Code computes five style properties for a semantic token: foreground, bold, italic, underline and strikethrough.

1. VS Code applies the semantic token rules of the theme and of the `editor.semanticTokenColorCustomizations` setting.
2. For each property that is still not set, VS Code applies the matching entries of `semanticTokenScopes`. For each property, the entry with the highest selector score wins.
3. Each entry has a list of probes. A probe is a stack of TextMate scopes. VS Code uses the first probe that matches a TextMate rule of the theme or of the `editor.tokenColorCustomizations` setting.
4. All properties that are still not set come from the TextMate token.

The selector score is the sum of these values:

* 10 if the selector has a language
* 100 minus the level of the token type in its supertype chain (0 for the wildcard `*`)
* 100 for each modifier

In a probe, the foreground and the font style can come from different TextMate rules. A TextMate `fontStyle` value sets all four font properties. The value `""` turns all four off.

## Markup tokens

Lean 4 sends markup tokens for Markdown and Verso in documentation comments and in Verso documents ([lean4#13674](https://github.com/leanprover/lean4/pull/13674)). Markup syntax, for example a delimiter, is a `keyword` token with the `markupSyntax` modifier.

The goal is that markup looks like the same Markdown in a `.md` file with the current theme. The exception is plain text in a documentation comment (`markupDocText`), which keeps the comment color.

### Base style

All markup token types have the supertype `markup`, which only exists in the client. The entry for `markup` gives the base style of all markup tokens. Its only probe is `meta.embedded.markup.lean4`:

* Most themes, including all built-in themes, give `meta.embedded` a plain text color. Embedded code in a `.md` file has this color. In some themes, for example Dark Modern, this color is a little different from the editor foreground.
* A TextMate rule in `configurationDefaults` gives `meta.embedded.markup.lean4` the font style `""`.

As a result, markup without a more specific style has the plain text color and no font style. This removes colors and font styles that the TextMate grammar gives to wrong Markdown matches and to Verso text that it reads as Lean code.

The TextMate rule is in `editor.tokenColorCustomizations` under the theme key `[*]`, which matches all themes. VS Code does not merge arrays in settings. Thus, the general `textMateRules` of a user replace a default list. VS Code joins the lists of all theme keys that match the current theme. Thus, only a user value for `textMateRules` under `[*]` replaces the rule.

### Construct styles

Each markup token type has an entry with two probes:

1. The scope stack that the Markdown grammar of VS Code gives to the same construct in a `.md` file
2. The scope that names the construct, alone, for example `markup.heading.markdown` for a heading

The second probe is not always the innermost scope of the stack. All built-in themes have a rule for `markup.heading`, but only three have a rule for `entity.name.section`. No built-in theme has a rule for `meta.paragraph`, the innermost scope of quotes and lists. The second probe only makes a difference in VS Code 1.75 to 1.94 (see [Older VS Code versions](#older-vs-code-versions)).

For a markup token type, the score of the `markup` entry is 99 and the score of its own entry is 100. Thus, the construct style wins for each property that the theme sets. The base style supplies all other properties.

The server does not tell ordered and unordered lists apart. `markupList` uses the scope of unordered lists, `markup.list.unnumbered.markdown`.

### Bold and italic

The selectors `markup.markupBold` and `markup.markupItalic` have the score 199. This score is higher than the score of the type entries. A selector like `*.markupBold` has the score 100, the same as the type entries, and the result then depends on the order of the entries.

Text that is both bold and italic matches both selectors with the same score. If both entries set a property, the entry that comes later in `semanticTokenScopes` wins. Thus, the italic entry wins, and the bold entry supplies the properties that the italic entry does not set.

A probe gets its font style from one TextMate rule only. Thus, a probe cannot make text both bold and italic. For this reason, `configurationDefaults` adds the semantic token rules `*.markupBold` (bold) and `*.markupItalic` (italic). The `rules` value is an object, so VS Code merges it with the rules of the user.

### Markup syntax

Markup syntax uses the `keyword` token type, which does not have the `markup` supertype. Thus, the first probe of `keyword.markupSyntax` has the base scope at its root: `meta.embedded.markup.lean4 text.html.markdown punctuation.definition.markdown`. A theme rule for Markdown punctuation matches a deeper scope, so it wins over the base scope. The second probe is the base scope alone.

If a theme has no rule for `meta.embedded` and no rule for Markdown punctuation, markup syntax gets the keyword foreground. This is different from the intent of the server. The server sends markup syntax as `keyword` tokens so that themes style it like keywords by default. With this mapping, markup syntax has a different color than keywords in all built-in themes.

### No language in the selectors

The selectors do not have a language. The Lean client serves documents with the language `lean4` and documents with the language `lean`. A selector with a language only applies to one of them.

## Older VS Code versions

The matching of probes against TextMate rules changed two times:

* VS Code 1.75 to 1.94: A probe with more than one scope only matches a rule with the same number of scope names. Thus, only the second probe of an entry matches.
* VS Code 1.95 to 1.98: The score of a match depends on the number and the length of the scope names in the rule. It does not depend on the position of the match in the probe.
* VS Code 1.99 and later: A rule that matches a deeper scope of the probe wins.

The base style is in a separate entry with one scope. Thus, these changes do not affect it. In VS Code 1.75 to 1.94, theme rules for the other scopes of a construct do not apply. Examples are rules for `entity.name.section` (heading text), `meta.link` (links) or `punctuation`.

## Known limitations

* The server sends the same token types for headings, blockquotes and list items in documentation comments and in Verso documents. In most themes, list and blockquote text in a documentation comment thus has the plain text color and not the comment color.
* Code blocks have the plain text color. The server does not send keyword tokens for Lean code in code blocks.
* If a theme does not enable semantic highlighting, only the TextMate grammar styles the markup.
* If a theme has no rule for `meta.embedded`, markup without a construct style keeps the foreground of the TextMate token.
* The bold and italic rules in `configurationDefaults` win over theme rules with the same or a lower score. VS Code applies the rules from the settings after the rules of the theme. A theme needs a rule with a higher score, for example `markup.markupBold`. A user can replace a rule with a user rule for the same selector, for example `"*.markupBold": { "bold": false }`.
* VS Code merges the `configurationDefaults` of different extensions only for settings with the schema type `object` (`mergeDefaultConfigurationsForConfigurationProperty` in `configurationRegistry.ts`). The schemas of `editor.tokenColorCustomizations` and `editor.semanticTokenColorCustomizations` use `allOf`. Another extension can also contribute a default for one of these settings. Then the extension that VS Code registers last replaces the default of the other extension.
  * If VS Code replaces the Lean default for `editor.tokenColorCustomizations`, markup gets stray bold and italic from the TextMate grammar again.
  * If VS Code replaces the Lean default for `editor.semanticTokenColorCustomizations`, bold and italic markup only gets the font style of the theme rules for `markup.bold` and `markup.italic`.

## How to examine the styles

1. Open a Lean file with a documentation comment.
2. Run the command **Developer: Inspect Editor Tokens and Scopes**.
3. Put the cursor on the markup.

The popup shows the semantic token type, the modifiers and the style that VS Code computes.
