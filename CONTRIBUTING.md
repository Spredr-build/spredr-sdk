# Contributing to @spredr/sdk

Thank you for helping. `@spredr/sdk` is owned and maintained by **Candhrly, LLC**, the company behind spredr. This page
says how to propose a change and the terms under which a contribution is accepted.

The SDK is not open source yet, and this repository is private: contributions come by invitation. The agreement below
already covers the day it opens.

## Proposing a change

1. Open an issue first for anything bigger than a small fix, so we can agree on the shape before you write it.
2. Keep the SDK dependency free: `src/` imports only `node:` built-ins and its own files. Keep its API typed end to end:
   no `any` beyond the untyped result, and a type test in `test/types.check.ts` for anything a user's types lean on.
3. Add a test for what you change: a fix comes with the test that failed before it. Then run, and keep green:
   ```sh
   npm install
   npm run check      # types (test/types.check.ts included), and that the SDK stands alone
   npm test           # every test, against a fake ai and a real agent on a free port
   npm run coverage   # the same, failing under 95% of lines, 85% of branches, 90% of functions
   npm run package    # the packed SDK, installed and compiled as a user gets it (publint, nodenext, bundler)
   ```
   Node 22.12 or newer. `prepublishOnly` runs all of it before a version leaves.
4. Open a pull request, and tick the agreement box in its description (below).

## Contributor License Agreement

By submitting a contribution (code, documentation or anything else) to this repository, you agree to these terms with
Candhrly, LLC («we»):

1. **Your work stays yours.** You keep the copyright in your contribution.
2. **Copyright license.** You grant us, and everyone who receives software we distribute, a perpetual, worldwide,
   non-exclusive, no-charge, royalty-free, irrevocable license to reproduce, modify, prepare derivative works of,
   publicly display, publicly perform, sublicense and distribute your contribution and such derivative works, under any
   license we choose, open source or not.
3. **Patent license.** You grant the same parties a perpetual, worldwide, non-exclusive, no-charge, royalty-free,
   irrevocable patent license to make, use, sell, offer to sell, import and otherwise transfer your contribution, for
   any patent claims you can license that your contribution, alone or combined with this SDK, would infringe.
4. **You can grant this.** The contribution is your original work, or you have the right to submit it under these
   terms. If your employer or anyone else has rights in what you create, you have their permission, or they have
   waived those rights for this contribution.
5. **Third-party material is named.** If part of the contribution is not yours, you say so in the pull request, with
   its source and license.
6. **No warranty.** You provide the contribution «as is», without warranties of any kind, and with no obligation to
   support it.
7. **No obligation to use it.** We may accept, change or decline any contribution.

You agree by ticking the box in the pull request template. If you contribute on behalf of a company, tell us in the
pull request and we will arrange an agreement with the company.

## Security

Do not report vulnerabilities in a public issue. See [SECURITY.md](SECURITY.md).

## Trademarks

The spredr name and logo are not licensed with the code. See [TRADEMARKS.md](TRADEMARKS.md).
