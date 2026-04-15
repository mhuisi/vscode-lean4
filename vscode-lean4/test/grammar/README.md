# Grammar snapshot tests

These tests use [`vscode-tmgrammar-test`](https://github.com/PanAeon/vscode-tmgrammar-test) to lock the tokenization of the TextMate grammars in `syntaxes/`.

## Layout

- `*.lean`: the source fixtures.
- `*.lean.snap`: the generated snapshots. Commit them with the fixtures.

## Commands

```bash
cd vscode-lean4
npm run test:grammar            # fails if the tokens differ from a snapshot, or if a fixture has no snapshot
npm run test:grammar:update     # writes the snapshots again (when the change is intended)
```

## Add a fixture

1. Add a `.lean` file to this folder. Start it with a comment that tells which regression it prevents.
2. Run `npm run test:grammar:update` to write the `.snap` file.
3. Read the `.snap` file and make sure that each scope is correct.
4. Commit both files.

## When the test fails

The tool prints the difference between the expected and the actual scopes.

- If the change is not intended, fix the grammar.
- If the change is intended, run `npm run test:grammar:update` and commit the new snapshot.
