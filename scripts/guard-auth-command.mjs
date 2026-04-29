#!/usr/bin/env node

const command = process.argv[2];

const guards = {
  deploy: {
    envName: "HYDRA_ALLOW_AUTH_DEPLOY",
    description: "deploy the auth worker",
  },
  "remote-migrate": {
    envName: "HYDRA_ALLOW_AUTH_REMOTE_MIGRATE",
    description: "run remote auth D1 migrations",
  },
};

const guard = guards[command];
if (!guard) {
  process.stderr.write(`Unknown auth guard command: ${command ?? "(missing)"}\n`);
  process.exit(1);
}

if (process.env[guard.envName] === "1") {
  process.exit(0);
}

process.stderr.write(
  `Refusing to ${guard.description} without ${guard.envName}=1. ` +
    "This guard exists to prevent accidental production auth changes.\n"
);
process.exit(1);
