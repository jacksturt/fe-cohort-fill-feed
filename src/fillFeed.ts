import WebSocket from "ws";
import { Connection, ConfirmedSignatureInfo, PublicKey } from "@solana/web3.js";

import { FillLog } from "@cks-systems/manifest-sdk/client/ts/src/manifest/accounts/FillLog";
import {
  OrderType,
  PlaceOrderLog,
  PROGRAM_ID,
} from "@cks-systems/manifest-sdk/client/ts/src/manifest";
import { convertU128 } from "@cks-systems/manifest-sdk/client/ts/src/utils/numbers";
import { genAccDiscriminator } from "@cks-systems/manifest-sdk/client/ts/src/utils/discriminator";
import * as promClient from "prom-client";
import { FillLogResult } from "@cks-systems/manifest-sdk/client/ts/src/types";

// Mainnet market address for commonly used market
const MARKET_ADDRESS = "CGA7cpvuPUm232ydGxcQCjbadgZNBsboSVjG9pNryqeZ";
// Poll every 500ms
const POLL_INTERVAL = 500;
// Stop parsing after 30 seconds of seeing no new signatures
const TIMEOUT = 30_000;

/**
 * FillLogResult is the message sent to subscribers of the FillFeed
 */
export type PlaceOrderLogResult = {
  /** Public key for the market as base58. */
  market: string;
  /** Public key for the trader as base58. */
  trader: string;
  /** Number of base atoms traded. */
  baseAtoms: string;
  /** Number of quote atoms traded. */
  price: number;
  /** Sequential number for every order placed / matched wraps around at u64::MAX */
  orderSequenceNumber: string;
  /** Index of the order in the orderbook. */
  orderIndex: number;
  /** Slot number of the order. */
  lastValidSlot: number;
  /** Type of the order. */
  orderType: OrderType;
  /** Boolean to indicate whether the order is a bid. */
  isBid: boolean;
  /** Padding to make the account size 128 bytes. */
  padding: number[];

  /** Slot number of the fill. */
  slot: number;
  /** Signature of the tx where the fill happened. */
  signature: string;
};

// For live monitoring of the fill feed. For a more complete look at fill
// history stats, need to index all trades.
const fills = new promClient.Counter({
  name: "fills",
  help: "Number of fills",
  labelNames: ["market", "isGlobal", "takerIsBuy"] as const,
});

/**
 * FillFeed example implementation.
 */
export class FillFeed {
  // Our websocket server
  private wss: WebSocket.Server;
  // Whether we should stop parsing logs. This happens when we haven't received
  // any new signatures for a while (set above in TIMEOUT).
  private shouldEnd: boolean = false;
  // Whether we have ended the parsing loop
  private ended: boolean = false;
  // Last time we updated parsed a log
  private lastUpdateUnix: number = Date.now();
  // Processing signatures to avoid processing the same signature twice
  private processingSignatures: Set<string> = new Set();

  constructor(private connection: Connection) {
    // Initialize websocket server on port 1234
    this.wss = new WebSocket.Server({ port: 1234 });

    // Handle new connections
    this.wss.on("connection", (ws: WebSocket) => {
      console.log("New client connected");

      // Handle incoming messages (we shouldn't receive any)
      ws.on("message", (message: string) => {
        console.log(`Received message: ${message}`);
      });

      // Handle client disconnect
      ws.on("close", () => {
        console.log("Client disconnected");
      });
    });
  }

  public msSinceLastUpdate() {
    return Date.now() - this.lastUpdateUnix;
  }

  /**
   * Stop parsing logs. Used if there is an error.
   */
  public async stopParseLogs() {
    // Set the flag to stop parsing logs
    this.shouldEnd = true;
    // Wait for the loop to end
    const start = Date.now();
    while (!this.ended) {
      const timeout = TIMEOUT;
      const pollInterval = POLL_INTERVAL;

      if (Date.now() - start > timeout) {
        return Promise.reject(
          new Error(`failed to stop parseLogs after ${timeout / 1_000} seconds`)
        );
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return Promise.resolve();
  }

  /**
   * Parse logs in an endless loop. Optionally end early (mainly for testing).
   */
  public async parseLogs(endEarly?: boolean) {
    // Get the last signature for the market
    const lastSignatureStatus = (
      await this.connection.getSignaturesForAddress(
        PROGRAM_ID,
        { limit: 1 },
        "finalized"
      )
    )[0];
    // Last signature we processed
    let lastSignature: string | undefined = lastSignatureStatus.signature;
    // Last slot we processed
    let lastSlot: number = lastSignatureStatus.slot;

    // End time for the loop
    const endTime: Date = endEarly
      ? new Date(Date.now() + 30_000)
      : new Date(Date.now() + 1_000_000_000_000);

    while (!this.shouldEnd && new Date(Date.now()) < endTime) {
      // Wait for 10 seconds
      await new Promise((f) => setTimeout(f, 10_000));
      // Get the signatures for the market
      let signatures: ConfirmedSignatureInfo[] = [];

      signatures = await this.connection.getSignaturesForAddress(
        PROGRAM_ID,
        // new PublicKey(MARKET_ADDRESS),
        { until: lastSignature },
        "finalized"
      );
      // Reverse the signatures to get the least recent first
      signatures.reverse();
      // If we didn't get any signatures, continue
      if (signatures.length < 1) {
        continue;
      }

      // Process the signatures
      for (const signature of signatures) {
        // If we are already processed this signature, continue
        if (this.processingSignatures.has(signature.signature)) {
          continue;
        }

        // If the signature is before the last slot we processed, continue
        if (signature.slot < lastSlot) {
          continue;
        }

        // Add the signature to the processing set
        this.processingSignatures.add(signature.signature);
        // Handle the signature
        await this.handleSignature(signature);
        // Remove the signature from the processing set
        this.processingSignatures.delete(signature.signature);
      }

      console.log(
        "New last signature:",
        signatures[signatures.length - 1].signature,
        "New last signature slot:",
        signatures[signatures.length - 1].slot,
        "num sigs",
        signatures.length
      );
      // Update the last signature and slot
      lastSignature = signatures[signatures.length - 1].signature;
      lastSlot = signatures[signatures.length - 1].slot;
      // Update the last time we parsed a log
      this.lastUpdateUnix = Date.now();

      // If we have more than 1000 signatures in the processing set, trim it
      if (this.processingSignatures.size > 1000) {
        const signaturesArray = Array.from(this.processingSignatures);
        this.processingSignatures = new Set(signaturesArray.slice(-1000));
      }
    }

    console.log("ended loop");
    this.wss.close();
    this.ended = true;
  }
  /**
   * Handle a signature by fetching the tx onchain and possibly sending a fill
   * notification.
   */
  private async handleSignature(signature: ConfirmedSignatureInfo) {
    console.log("Handling", signature.signature, "slot", signature.slot);
    // Get the tx onchain
    const tx = await this.connection.getTransaction(signature.signature, {
      maxSupportedTransactionVersion: 0,
    });
    // If we didn't get any log messages, continue
    if (!tx?.meta?.logMessages) {
      console.log("No log messages");
      return;
    }
    // If the tx failed, continue
    if (tx.meta.err != null) {
      console.log("Skipping failed tx", signature.signature);
      return;
    }
    // Get the log messages
    const messages: string[] = tx?.meta?.logMessages!;
    // Get the program data log messages. Use the set to remove duplicates.
    const programDatas: string[] = Array.from(
      new Set(
        messages.filter((message) => {
          return message.includes("Program data:");
        })
      )
    );
    // If we didn't get any program data log messages, continue
    if (programDatas.length == 0) {
      console.log("No program datas");
      return;
    }
    // Process the program data log messages
    for (const programDataEntry of programDatas) {
      // Get the program data
      const programData = programDataEntry.split(" ")[2];

      // Convert the program data to a byte array
      const byteArray: Uint8Array = Uint8Array.from(atob(programData), (c) =>
        c.charCodeAt(0)
      );
      // Convert the byte array to a buffer
      const buffer = Buffer.from(byteArray);

      // We match here for any logs that start with "Program data: OubyA0txBKn"
      // For example, FillLog in this transaction in the logs for #3 Unknown Program:
      // https://explorer.manifest.trade/tx/52EJq5pz9whFDXphqyTv9CYJ6rfeuHFzLiawruefjwwFV82LvhjCcYY1L3qpHByq8m4Qic5FUGhhWWuP3bdMjXgb
      if (buffer.subarray(0, 8).equals(fillDiscriminant)) {
        // Deserialize the fill log. See implementation of FillLog.deserialize here:
        // https://github.com/CKS-Systems/manifest/blob/main/client/ts/src/manifest/accounts/FillLog.ts#L133
        const deserializedFillLog: FillLog = FillLog.deserialize(
          buffer.subarray(8)
        )[0];
        // Convert the fill log to a string:
        const resultString: string = JSON.stringify(
          toFillLogResult(
            deserializedFillLog,
            signature.slot,
            signature.signature
          )
        );
        console.log("Got a fill", resultString);
        // Add the fill to the prom stats:
        fills.inc({
          market: deserializedFillLog.market.toString(),
          isGlobal: deserializedFillLog.isMakerGlobal.toString(),
          takerIsBuy: deserializedFillLog.takerIsBuy.toString(),
        });
        // Send the fill to the websocket clients:
        this.wss.clients.forEach((client) => {
          client.send(
            JSON.stringify({
              type: "fill",
              data: toFillLogResult(
                deserializedFillLog,
                signature.slot,
                signature.signature
              ),
            })
          );
        });
      }
      // We match here for any logs that start with "Program data: nXb31S8TpHj"
      // For example, PlaceOrderLog in this transaction in the logs for #4 Wrapper Instruction:
      // https://explorer.manifest.trade/tx/5MKatboSMop9tqSrDhhpRccYxRgjTCRbQ6P54GbAZ5Z2Jbovg7tebq72kpxWvDi8UX5rZrC9kbJJBoH7aqu6pY12
      else if (buffer.subarray(0, 8).equals(placeOrderDiscriminant)) {
        // Deserialize the place order log. See implementation of PlaceOrderLog.deserialize here:
        // https://github.com/CKS-Systems/manifest/blob/main/client/ts/src/manifest/accounts/PlaceOrderLog.ts#L124
        const deserializedPlaceOrderLog: PlaceOrderLog =
          PlaceOrderLog.deserialize(buffer.subarray(8))[0];
        // Convert the place order log to a string for printing:
        const resultString: string = JSON.stringify(
          toPlaceOrderLogResult(
            deserializedPlaceOrderLog,
            signature.slot,
            signature.signature
          )
        );

        // Log the order:
        console.log("Got an order", resultString);
        // Send the order to the websocket clients:
        this.wss.clients.forEach((client) => {
          client.send(
            JSON.stringify({
              type: "placeOrder",
              data: toPlaceOrderLogResult(
                deserializedPlaceOrderLog,
                signature.slot,
                signature.signature
              ),
            })
          );
        });
      } else {
        continue;
      }
    }
  }
}
// Discriminants for the fill logs. Used to match the logs in the tx logs.
const fillDiscriminant = genAccDiscriminator("manifest::logs::FillLog");
// Convert from serialized fill log to a JSON for printing.
function toFillLogResult(
  fillLog: FillLog,
  slot: number,
  signature: string
): FillLogResult {
  return {
    market: fillLog.market.toBase58(),
    maker: fillLog.maker.toBase58(),
    taker: fillLog.taker.toBase58(),
    baseAtoms: fillLog.baseAtoms.inner.toString(),
    quoteAtoms: fillLog.quoteAtoms.inner.toString(),
    priceAtoms: convertU128(fillLog.price.inner),
    takerIsBuy: fillLog.takerIsBuy,
    isMakerGlobal: fillLog.isMakerGlobal,
    makerSequenceNumber: fillLog.makerSequenceNumber.toString(),
    takerSequenceNumber: fillLog.takerSequenceNumber.toString(),
    signature,
    slot,
  };
}
// Discriminants for the place order logs. Used to match the logs in the tx logs.
const placeOrderDiscriminant = genAccDiscriminator(
  "manifest::logs::PlaceOrderLog"
);
// Convert from non-serialized place order log to a JSON for printing.
function toPlaceOrderLogResult(
  placeOrderLog: PlaceOrderLog,
  slot: number,
  signature: string
): PlaceOrderLogResult {
  return {
    market: placeOrderLog.market.toBase58(),
    trader: placeOrderLog.trader.toBase58(),
    baseAtoms: placeOrderLog.baseAtoms.inner.toString(),
    price: convertU128(placeOrderLog.price.inner),
    orderSequenceNumber: placeOrderLog.orderSequenceNumber.toString(),
    orderIndex: placeOrderLog.orderIndex,
    lastValidSlot: placeOrderLog.lastValidSlot,
    orderType: placeOrderLog.orderType,
    isBid: placeOrderLog.isBid,
    padding: placeOrderLog.padding,
    signature,
    slot,
  };
}
