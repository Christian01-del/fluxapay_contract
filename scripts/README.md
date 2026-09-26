# FluxaPay Deployment Scripts

## `deploy.sh`

Deploys all six FluxaPay contracts to a Stellar network in dependency order,
initialises each contract with the deployer as admin, and writes the resulting
contract IDs to `.env.testnet`.

### Usage

```bash
./deploy.sh [network]
```

The network may be supplied as an optional positional argument or via the
`STELLAR_NETWORK` environment variable. The positional argument takes
precedence over the environment variable. When neither is provided the network
defaults to `testnet`.

Accepted networks: `testnet` | `futurenet` | `standalone`.

### Examples

```bash
# Deploy to testnet (default)
./deploy.sh testnet

# Deploy to futurenet via the environment variable
STELLAR_NETWORK=futurenet ./deploy.sh

# Deploy to a standalone sandbox
./deploy.sh standalone

# Seed test data after deploy
SEED_DATA=true ./deploy.sh testnet

# Skip the cargo build step
SKIP_BUILD=true ./deploy.sh testnet
```

An unknown network value prints usage and exits non-zero.

### Environment variables

| Variable            | Required | Description                                              |
| ------------------- | -------- | -------------------------------------------------------- |
| `STELLAR_SECRET_KEY`| yes      | Deployer secret key (starts with `S`)                    |
| `STELLAR_NETWORK`   | no       | Target network (`testnet` \| `futurenet` \| `standalone`)|
| `STELLAR_RPC_URL`   | no       | Override the RPC endpoint                                |
| `SEED_DATA`         | no       | Set to `true` to seed test data after deploy             |
| `SKIP_BUILD`        | no       | Set to `true` to skip the cargo build step               |

## `deploy-testnet.sh`

Deprecated. Kept for backward compatibility; it prints a warning and delegates
to `deploy.sh`, defaulting to `testnet` when no network is supplied.
