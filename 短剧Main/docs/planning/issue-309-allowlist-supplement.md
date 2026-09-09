# Issue #309 file allowlist supplement

This supplement authorizes the Snapshot A composition-root wiring that is
required to construct the trusted TOS verification and existing controlled
registration adapter at runtime:

- `src/app.ts`
- `src/composition/seedanceAssetRegistration.ts`
- `src/composition/seedanceAssetRegistration.test.ts`
- `src/composition/snapshotAImport.ts`
- `src/composition/snapshotAImport.test.ts`

The authorization is limited to Snapshot A dependency construction and its
unit tests. It does not authorize unrelated application-root, composition,
provider, route, or environment changes.
