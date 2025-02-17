# Manifest Fill Feed

Based on the [Manifest Orderbook](https://github.com/CKS-Systems/manifest/tree/main/client) repository.

This is a simple feed that listens for fills and orders on the Manifest DEX and logs them to the console.

## Running

```bash
npm install
npm run start
```

## Metrics

The feed also serves a prometheus metrics endpoint at `http://localhost:9090/metrics`.

## Websocket

The feed also serves a websocket endpoint at `ws://localhost:1234`.

## ENV Variables

The feed uses the following environment variables:

- `NEXT_PUBLIC_RPC_URL`: The URL of the RPC to connect to.

## Other Variables (Top of fillFeed.ts)

- `TIMEOUT`: The timeout for the feed in milliseconds.
- `POLL_INTERVAL`: The interval for the feed monitor in milliseconds.
- `MARKET_ADDRESS`: The address of the market to listen to. (You need to comment out line 154 and uncomment line 155 to listen to a specific market.)

## Deploy to Railway

Login to railway.app
Create a new project
Choose "Deploy from GitHub repository"
Select your repository
Railway will automatically detect that it's a Node.js application and set up the deployment

## Configure environment variables in Railway's dashboard

Go to your project settings
Add any necessary environment variables
