# ERC-4337 Smart Account + Verifying Paymaster

A minimal, self-contained account abstraction setup:

- **`SmartAccount`** — ERC-4337 account owned by a single ECDSA key, with `execute`,
  `executeBatch` and ERC-1271 signature validation.
- **`SmartAccountFactory`** — deterministic (CREATE2) deployment, idempotent so it can be used
  as a UserOperation's `initCode`.
- **`VerifyingPaymaster`** — sponsors UserOperations carrying an EIP-712 signature from an
  authorized signer, either for free or against an ERC-20 fee charged in `postOp`.
- **`FeeSwapper`** — optional: converts fees collected in any ERC-20 into one canonical token
  through Uniswap V3, in the same `postOp`.

Built on Hardhat 3, TypeScript, viem, OpenZeppelin v5 and the official
`@account-abstraction/contracts` (EntryPoint v0.8).

## Setup

Requires Node.js ≥ 22.

```bash
npm install
cp .env.example .env      # only needed for a live network
npx hardhat compile
npx hardhat test
```

The test suite is fully local — it deploys its own EntryPoint, so it needs no RPC endpoint,
no API key and no network access.

## Usage

### Local walkthrough

The interaction scripts share state through `deployments/<chainId>.json`, so run them against a
persistent node rather than the in-process one:

```bash
npx hardhat node                                              # terminal 1

npx hardhat run scripts/deploy.ts --network localhost         # terminal 2
npx hardhat run scripts/create-account.ts --network localhost
npx hardhat run scripts/deposit-paymaster.ts --network localhost
npx hardhat run scripts/send-sponsored-user-op.ts --network localhost
```

The last script prints something like:

```
Smart account: 0xc4351b9c1Fc17b01988eE3F2d63DB8D6700E80B7 (deployed)
Paymaster deposit: 0.1 ETH
Counter: 0 -> 1
Paymaster paid: 0.00029114377186734 ETH
Account ETH balance: 0
```

The account executed a transaction while holding zero ETH — the paymaster's EntryPoint deposit
paid for it.

### On a live network

Fill in `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `PAYMASTER_SIGNER_PRIVATE_KEY` and
`ACCOUNT_OWNER_PRIVATE_KEY`, then run the same scripts with `--network sepolia`. The canonical
EntryPoint v0.8 (`0x4337084d9e255ff0702461cf8895ce9e3b5ff108`) is used instead of a locally
deployed one.

### Scripts

| Script                              | What it does                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `scripts/deploy.ts`                 | Deploys the factory, the paymaster and a demo target, funds the paymaster's deposit, writes `deployments/<chainId>.json` |
| `scripts/create-account.ts`         | Deploys the smart account for the configured owner and salt (idempotent)                                                 |
| `scripts/deposit-paymaster.ts`      | Tops up the paymaster's EntryPoint deposit                                                                               |
| `scripts/send-sponsored-user-op.ts` | Builds, signs and submits a sponsored UserOperation                                                                      |

To settle the same operation in ERC-20 instead of sponsoring it outright, set an exchange rate —
fee tokens per 1e18 wei of gas:

```bash
FEE_EXCHANGE_RATE=3000000000 npx hardhat run scripts/send-sponsored-user-op.ts --network localhost
```

```
Mode: ERC-20 0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82 @ 3000000000
Counter: 2 -> 3
Paymaster paid: 0.000236513804257701 ETH
Fee charged: 745006 token units
Account balance: 0 ETH
```

Add `FEE_POOL_FEE=500` to also swap the collected fee into the canonical token:

```
Fee charged: 1332520 token units
```

On a local chain `deploy.ts` deploys a `MockERC20`, a mock Uniswap V3 (factory, quoter, router)
and a `FeeSwapper`, wires them into the paymaster and registers a pool, so both modes work out of
the box. Elsewhere point `FEE_TOKEN` at a real token and deploy `FeeSwapper` against the real
Uniswap V3 addresses.

`send-sponsored-user-op.ts` calls `EntryPoint.handleOps` directly — the script acts as its own
bundler, which keeps the flow free of third-party services. On a network with a public
UserOperation mempool you would hand the same signed operation to a bundler instead.

If the account has not been deployed yet, the script attaches its `initCode` so the EntryPoint
deploys it as part of the sponsored operation.

## How sponsorship works

`paymasterAndData` carries a fixed-width payload, 184 bytes in total, parsed with plain calldata
slicing behind an exact length check:

| Offset | Size | Field                                                          |
| ------ | ---- | -------------------------------------------------------------- |
| 0      | 20   | paymaster address                                              |
| 20     | 16   | `paymasterVerificationGasLimit`                                |
| 36     | 16   | `paymasterPostOpGasLimit`                                      |
| 52     | 6    | `validUntil`                                                   |
| 58     | 6    | `validAfter`                                                   |
| 64     | 20   | fee token, or the zero address for a free sponsorship          |
| 84     | 32   | `exchangeRate` — fee tokens per 1e18 wei of gas cost           |
| 116    | 3    | `poolFee` — Uniswap V3 tier used to swap the fee, 0 to keep it |
| 119    | 65   | authorized signer's EIP-712 signature                          |

The signer's digest covers `sender`, `nonce`, `initCode`, `callData`, the packed gas fields,
`validUntil`, `validAfter`, `token`, `exchangeRate` and `poolFee`, with the EIP-712 domain
pinning it to this paymaster and this chain. It deliberately excludes `paymasterAndData` itself
(which carries the signature) and `userOp.signature` (the account signs afterwards, over a hash
that includes `paymasterAndData`).

A wrong signature is reported as `SIG_VALIDATION_FAILED` rather than a revert, and the time
window is returned through `_packValidationData` so the EntryPoint enforces it — an operation
outside its window fails with `AA32 paymaster expired or not due`.

**Free mode** (`token == address(0)`) returns an empty context, so the EntryPoint skips `postOp`
entirely. **Token mode** verifies up front that the account can cover the worst-case fee, then
charges the exact amount in `postOp` based on the gas actually consumed, rounded up.

### Fee swapping

With a `FeeSwapper` set and enabled, `postOp` also converts the collected fee into the
paymaster's canonical token through Uniswap V3, quoting first and applying a slippage tolerance.
The swapper never reverts: if there is no pool, the quote is unusable or the router fails, the
fee token is left with (or returned to) the paymaster and a `SwapFailed` event is emitted. An
already-executed UserOperation can never fail because of a swap.

Two things to keep in mind when enabling it:

- the swap needs a much larger `paymasterPostOpGasLimit` (the scripts use 500 000; the default
  150 000 is not enough and the operation would revert in `postOp`);
- the paymaster bills the account for the swap gas as well, so the fee charged in token mode is
  noticeably higher than without swapping.

## Design notes

A few decisions that are easy to get wrong in ERC-4337 and are worth calling out:

**Validation never reverts on a bad signature.** `SmartAccount._validateSignature` and
`VerifyingPaymaster._validatePaymasterUserOp` use `ECDSA.tryRecover` and return
`SIG_VALIDATION_FAILED`. `ECDSA.recover` would revert on a malformed signature, turning a clean
`AA24`/`AA34` into `AA23 reverted` — and under ERC-7562 a paymaster that reverts on
user-controlled input gets throttled by bundlers. The reference `SimpleAccount` has this problem;
this one does not.

**Time bounds are returned, not enforced inline.** `_packValidationData(sigFailed, validUntil,
validAfter)` hands the window to the EntryPoint. Comparing against `block.timestamp` inside
validation is both a banned opcode and a loss of information for the bundler.

**`createAccount` is idempotent.** It computes the counterfactual address first and returns it
unchanged when code already exists there. `initCode` runs only once, but
`entryPoint.getSenderAddress()` and off-chain tooling call the factory speculatively — a second
call that reverts breaks both.

**`isValidSignature` never reverts**, including on a malformed signature length. ERC-1271 callers
branch on the magic value, so a revert breaks them.

**No on-chain nonce in the paymaster.** The UserOperation's own nonce plus the
sender/chain/paymaster binding inside the EIP-712 domain already prevent replay, which keeps
validation free of storage writes.

**The swapper cannot fail an operation.** Every branch is swallowed into a `SwapFailed` event,
because `postOp` runs after the operation has already executed — a revert there would waste the
paymaster's gas and undo a successful call.

**Swap gas is billed to the account.** `postOp` decides whether a swap will happen _before_
computing the fee, so the extra ~180k gas lands on the account rather than being absorbed by the
paymaster.

## Layout

```
contracts/
  SmartAccount.sol            account: owner ECDSA, execute, executeBatch, ERC-1271
  SmartAccountFactory.sol     CREATE2 deployment of account proxies
  VerifyingPaymaster.sol      sponsorship validation and fee settlement
  FeeSwapper.sol              converts collected fees into the canonical token
  components/                 shared modifiers and the approval helper
  errors/                     custom errors
  interfaces/
  mocks/                      TestCounter, MockERC20, mock Uniswap V3
lib/                          shared TypeScript used by both tests and scripts
scripts/                      deploy and interaction scripts
test/unit/                    contracts exercised directly
test/integration/             full handleOps flows through a real EntryPoint
test/fork/                    swapper against the real Uniswap V3, opt-in
```

Shared TypeScript lives in `lib/` rather than `test/utils/` because the Hardhat 3 node test
runner treats every `.ts` file under `test/` as a test file, and the UserOperation builders are
needed by the scripts anyway.

## Tests

```bash
npx hardhat test
```

70 tests across five files: factory determinism and idempotency, account execution and signature
validation, paymaster configuration/validation/settlement, swapper access control and every swap
failure path, and end-to-end sponsored operations including counterfactual deployment, ERC-20
settlement, fee swapping, and the `AA24` / `AA25` / `AA31` / `AA32` / `AA34` rejection paths.

### Fork tests

`test/fork` verifies the swapper against the **real** Uniswap V3 on an Ethereum mainnet fork —
it wraps ETH, sells WETH for USDC through the live router and checks the no-pool fallback. This
is what proves the interfaces, the quote and the router call line up on chain, which mocks cannot.

They are skipped unless `MAINNET_RPC_URL` is set, so the default run stays offline:

```bash
MAINNET_RPC_URL=https://... npm run test:fork
```

The fork is unpinned, so it runs against the current chain head. Note that `hardhat test` takes
file paths, not directories — hence the explicit path in the `test:fork` script.

## Security notes

This is a reference implementation, not audited code. Before any production use consider at
least: a two-step or timelocked signer rotation, per-account or per-sponsor spending limits, an
allowlist of callable targets, and `addStake` on the paymaster (exposed but not called by the
scripts) since bundlers require staked paymasters to accept operations from the public mempool.
