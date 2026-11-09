PROPOSED — synthetic Bundle exact-byte handoff v1

This pack is a review vector, not an approved production format, real approved restaurant bundle, deployed asset or passing application test. All URLs/IDs/content are synthetic.

Proposed boundary: producer first validates/normalizes with shared Bundle schema, deterministically serializes once, and hashes/stores the SAME UTF-8 bytes. DIN-03 obtains response.arrayBuffer(), hashes those bytes before decoding/parsing or schema normalization, compares response.bundle.contentHash, then decodes UTF-8 strictly, parses JSON and checks PublicMenuDeliverySchema identity before display. Do not parse/re-stringify before digest comparison. publicationHash metadata algorithm is unchanged. Object/CDN must not rewrite JSON.

Do not hash manifest.json or the ZIP. Hash only the exact selected bundle file bytes. bundle.original.json has no BOM or final newline and includes non-ASCII characters. The sorted-key serializer used to create this illustrative vector does not prescribe a new production canonicalization algorithm. A producer may use an agreed deterministic serializer, but must store/hash its same final bytes; array order is display order.

Files: original; same JSON value with pretty formatting (must fail against original digest); one-name byte mutation (must fail); validly encoded different revision (even a matching digest must fail the ORIGINAL response identity). See manifest expected outcomes. Hash expectations were calculated/re-read using Python stdlib only. Shared-schema execution, producer tests, DIN-03/browser tests, R2/CDN/CORS and hosted delivery are all NOT RUN.

Next: producer and DIN-03 explicitly confirm the rule in #117, adopt these cases inside their EXISTING implementation tests, attach exact code/head/results, and replace synthetic examples with pinned human-approved content for the hosted gate. Do not enable live mode before digest+identity+error tests pass.

Local follow-up: validate-hash-fixture.mjs ran against a734c50 shared contracts. Four content files pass the strict content schema; all five proposed digest/identity cases pass the local harness, including rejection of matching-digest wrong revision. This is NOT the producer implementation, browser fetch/display integration, signed-token verification or hosted acceptance.
