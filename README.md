# HollaEx Kit [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-green.svg)](https://github.com/facebook/create-react-app/pulls)
HollaEx Kit is an open source white label crypto software suite with a range of features from exchange and trading to user management and onboarding as well as wallet system. In order to run the HollaEx Kit, you need to run the Server as the back-end and Web as your front-end user interface. HollaEx Kit runs as a stand alone node and for trading and blockchain functionalities require to connect to HollaEx Network. By default the node connects to the public HollaEx Network.

## Get Started

HollaEx Kit provides simple (but powerful) CLI tool to help exchange operators setup and operate the exchange. Get started by install HollaEx CLI and following the [documentation](https://docs.hollaex.com) to start your own exchange.

```
git clone https://github.com/hollaex/hollaex-kit.git

bash install.sh
```
Read more on our [Docs](https://docs.hollaex.com)!

## Developers

Checkout [Web](https://github.com/hollaex/hollaex-kit/tree/master/web) for the front-end UI/UX code.

Check out [Server](https://github.com/hollaex/hollaex-kit/tree/master/server) for back-end and server side operations and endpoints.

Check out [Plugins](https://github.com/hollaex/hollaex-kit/tree/2.0-develop/server#plugins) for developing seamless and flexible custom services that can be added to the HollaEx Kit.

Check out [HollaEx CLI](https://github.com/hollaex/hollaex-cli) (Command Line Interface) for interacting and deploying your exchange.

Check out [HollaEx Network Library](https://github.com/hollaex/hollaex-kit/tree/master/server/utils/hollaex-network-lib) for tools and functions used to communicate with HollaEx Network.

Check out [HollaEx Tools Library](https://github.com/hollaex/hollaex-kit/tree/master/server/utils/hollaex-tools-lib) for developers as a suite of all useful functions in the HollaEx Kit.

## Run locally

You can run the HollaEx Kit locally with Docker for the backend and the React development server for the frontend.

### Prerequisites

- Docker Engine and Docker Compose v2
- Node.js (LTS) and npm

### Backend

1. Copy the local environment template and set the values you need (admin credentials, captcha keys, etc.).

   ```bash
   cp server/tools/hollaex-kit.env.local.example server/tools/hollaex-kit.env.local
   ```

2. Start the API, Postgres, and Redis stack in development mode.

   ```bash
   cd server
   docker compose -f docker-compose.yaml up --build
   ```

   The API will be available directly on `http://localhost:10010` and through the NGINX proxy on `http://localhost/api`; websocket traffic is proxied on `ws://localhost/stream`.

### Frontend

1. Create a local environment file for the web client that points to the locally running backend.

   ```bash
   cd web
   cp .env .env.local
   cat <<'EOF' > .env.local
   REACT_APP_PUBLIC_URL=http://localhost:3000
   REACT_APP_SERVER_ENDPOINT=http://localhost/api
   REACT_APP_STREAM_ENDPOINT=ws://localhost/stream
   REACT_APP_NETWORK=testnet
   REACT_APP_EXCHANGE_NAME="hollaex-kit-local"
   EOF
   ```

2. Install dependencies and start the development server.

   ```bash
   npm install
   npm run start
   ```

   The React app will be served on `http://localhost:3000` and communicate with the locally running backend.

## Community
Join us on the [Forum](https://forum.hollaex.com), [Discord](https://discord.gg/RkRHU8RbyM) and [Twitter](http://www.twitter.com/hollaex).


<a href="https://github.com/hollaex/hollaex-kit/graphs/contributors">
  <img src="https://contributors-img.web.app/image?repo=hollaex/hollaex-kit" />
</a>


## Useful Links

- Exchange Dashboard: https://dash.hollaex.com
- HollaEx Whitepaper: https://whitepaper.hollaex.com
- HollaEx Live Exchange: https://pro.hollaex.com/trade/xht-usdt
- Discord Community: https://discord.gg/RkRHU8RbyM
- Forum: https://forum.hollaex.com
- Docs: https://docs.hollaex.com
