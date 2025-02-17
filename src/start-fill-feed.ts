import "dotenv/config";

import { FillFeed } from "./fillFeed";
import { Connection } from "@solana/web3.js";
import * as promClient from "prom-client";
import express from "express";
import promBundle from "express-prom-bundle";
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
// Get the rpc url from the environment variable.
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;
// Set up the monitor feed function. This will print every 5 minutes if the feed has not updated.
const monitorFeed = async (feed: FillFeed) => {
  // 5 minutes
  const deadThreshold = 300_000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(60_000);
    const msSinceUpdate = feed.msSinceLastUpdate();
    if (msSinceUpdate > deadThreshold) {
      throw new Error(
        `fillFeed has had no updates since ${
          deadThreshold / 1_000
        } seconds ago.`
      );
    }
  }
};

const run = async () => {
  // Prometheus monitoring for this feed on the default prometheus port.
  promClient.collectDefaultMetrics({
    labels: {
      app: "fillFeed",
    },
  });
  // Set up the prometheus metrics app.
  const register = new promClient.Registry();
  register.setDefaultLabels({
    app: "fillFeed",
  });
  const metricsApp = express();
  metricsApp.listen(9090);

  // Set up the prometheus metrics middleware.
  const promMetrics = promBundle({
    includeMethod: true,
    metricsApp,
    autoregister: false,
  });
  metricsApp.use(promMetrics);

  // Set the timeout for the feed.
  const timeoutMs = 5_000;

  console.log("starting feed...");
  let feed: FillFeed | null = null;
  if (!rpcUrl) {
    throw new Error("NEXT_PUBLIC_RPC_URL is not set");
  }
  while (true) {
    try {
      // Set up the connection to the rpc.
      console.log("setting up connection...");
      const conn = new Connection(rpcUrl, "confirmed");
      // Set up the feed.
      console.log("setting up feed...");
      feed = new FillFeed(conn);
      // Parse the logs ever onwards.
      console.log("parsing logs...");
      await Promise.all([monitorFeed(feed), feed.parseLogs(false)]);
    } catch (e: unknown) {
      // If there is an error, shut down the feed and restart.
      console.error("start:feed: error: ", e);
      if (feed) {
        console.log("shutting down feed before restarting...");
        await feed.stopParseLogs();
        console.log("feed has shut down successfully");
      }
    } finally {
      console.warn(`sleeping ${timeoutMs / 1000} before restarting`);
      sleep(timeoutMs);
    }
  }
};

// Run the feed.
run().catch((e) => {
  console.error("fatal error");
  // we do indeed want to throw here
  throw e;
});
