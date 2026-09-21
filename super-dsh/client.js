// super-dsh client face — re-export the hub's client half (selector mount:
// sidebar footer action + runtime seat). The dsh web app resolves this
// package's `./client` subpath via the `dsh.client` manifest in package.json.
export { apply, inject } from '@pgmi-builds/agent-hub/client'
