import { Big } from "big.js";
import Exchange, { ExchangeStatuses } from "../lib/exchange";
import WSConnector from "../lib/wsConnector";
import Util from "../common/util";
import Sleep from "sleep-promise";
import Quant from "../quant";
import { OrderBookDatasetItem } from "../lib/orderBook";
import { OrderType } from "../common/constants";

export default class Binance extends Exchange {
  wsConnector: BinanceWSConnector;
  exchangeInfoMap: Map<string, BinanceExchangeInformation> = new Map();
  // exchangeInfoList: BinanceExchangeInformation[] | undefined;

  tempOrderBookStreamBuffer: Map<string, Map<number, any>> = new Map();
  tempOrderBookInitialized: Map<string, boolean> = new Map();

  constructor(quant: Quant, config: any, exchangeConfig: any) {
    super(quant, config, exchangeConfig);

    this.wsConnector = new BinanceWSConnector(this.exchangeConfig.webSocketUrl);
  }

  init(): void {
    this.updateMarketInfoTimer();

    this.wsConnector.on("open", async () => {
      console.log("connect binance..");
      this.emit("updateStatus", ExchangeStatuses.running);

      const exchangeInfoList = await this.getExchangeInformation();
      if (!exchangeInfoList) {
        return console.log("binance error..");
      }

      for (let i = 0; i < exchangeInfoList.length; i++) {
        const exchangeInfo = exchangeInfoList[i];
        this.exchangeInfoMap.set(exchangeInfo.symbol, exchangeInfo);
        // this.quant.addMarketList(this.id, exchangeInfo.baseAsset, exchangeInfo.quoteAsset);

        this.tempOrderBookInitialized.set(exchangeInfo.symbol, false);
        this.tempOrderBookStreamBuffer.set(exchangeInfo.symbol, new Map());

        this.wsConnector.sendMessage(
          JSON.stringify({
            method: "SUBSCRIBE",
            params: [`${exchangeInfo.symbol.toLowerCase()}@depth`],
            id: i
          })
        );

        const option = {
          method: "GET",
          url: `${this.endPoint}/api/v3/depth?symbol=${exchangeInfo.symbol}&limit=50`
        };

        const [err, result] = await Util.request(option);
        if (err) {
          console.log(JSON.stringify(err));
          continue;
        }

        // updateOrderBook
        this.updateOrderBook(exchangeInfo.baseAsset, exchangeInfo.quoteAsset, OrderType.ask, result.data.asks);
        this.updateOrderBook(exchangeInfo.baseAsset, exchangeInfo.quoteAsset, OrderType.bid, result.data.bids);

        //

        const tempOrderBookBuffer = this.tempOrderBookStreamBuffer.get(exchangeInfo.symbol);
        if (!tempOrderBookBuffer) {
          this.tempOrderBookInitialized.set(exchangeInfo.symbol, true);
          await Sleep(200);
          continue;
        }

        for (const [u, orderBookBuffer] of tempOrderBookBuffer) {
          if (orderBookBuffer.U <= result.data.lastUpdateId + 1 && u >= result.data.lastUpdateId) {
            // this.emit('updateOrderBookByDataset', undefined);
          }
        }

        this.tempOrderBookInitialized.set(exchangeInfo.symbol, true);
        await Sleep(200);
      }
    });

    this.wsConnector.on("message", message => {
      this.messageHandler(JSON.parse(message.data));
    });

    this.wsConnector.on("close", async () => {
      console.log("close binance..");
      this.emit("updateStatus", ExchangeStatuses.disconnected);
    });

    this.wsConnector.on("error", async err => {
      console.log(`error binance : ${JSON.stringify(err)}`);
    });

    this.emit("updateStatus", ExchangeStatuses.initialized);
  }

  start(): void {
    console.log("start binance..");
    this.wsConnector.start();
  }

  stop(): void {
    this.tempOrderBookStreamBuffer.clear();
    this.tempOrderBookInitialized.clear();
  }

  private updateOrderBook(baseAsset: string, quoteAsset: string, orderType: OrderType, data: any[]) {
    const orderbookData: OrderBookDatasetItem[] = [];
    for (const item of data) {
      orderbookData.push({
        bgPrice: new Big(item[0]),
        bgAmount: Number(item[1]) === 0 ? undefined : new Big(item[1])
      });
    }

    this.updateOrderBookByDataset(baseAsset, quoteAsset, this.id, orderType, orderbookData);
  }

  private async updateMarketInfoTimer() {
    const execution = async () => {
      const exchangeInfoList = await this.getExchangeInformation();
      if (!exchangeInfoList) {
        return console.log("binance get exchange information error..");
      }

      const marketList: string[] = [];
      for (let i = 0; i < exchangeInfoList.length; i++) {
        const exchangeInfo = exchangeInfoList[i];
        // marketList.push([exchangeInfo.baseAsset, exchangeInfo.quoteAsset]);
        marketList.push(`${exchangeInfo.baseAsset}/${exchangeInfo.quoteAsset}`);
      }

      this.quant.updateMarketList(this.id, marketList);
    };

    await execution();
    setInterval(async () => {
      await execution();
    }, 1000 * 60 * 60 * 24);
  }

  async getExchangeInformation(): Promise<BinanceExchangeInformation[] | undefined> {
    const option = {
      method: "GET",
      url: `${this.endPoint}/api/v3/exchangeInfo`
    };

    const [err, result] = await Util.request(option);
    if (err) {
      console.dir(JSON.stringify(err));
      return undefined;
    }

    const dataList: BinanceExchangeInformation[] = [];
    for (const symbol of result.data.symbols) {
      if (!this.quant.isAvailableMarket(symbol.baseAsset, symbol.quoteAsset)) continue;
      if (symbol.status !== "TRADING" || symbol.permissions.findIndex((x: string) => x === "SPOT") === -1) continue;

      dataList.push({
        symbol: symbol.symbol,
        status: symbol.status,
        baseAsset: symbol.baseAsset,
        baseAssetPrecision: symbol.baseAssetPrecision,
        quoteAsset: symbol.quoteAsset,
        quoteAssetPrecision: symbol.quoteAssetPrecision,
        filters: symbol.filters
      });
    }

    return dataList;
  }

  messageHandler(message: any) {
    switch (message.e) {
      case "depthUpdate": {
        if (!this.tempOrderBookInitialized.get(message.s)) {
          let tempOrderBook = this.tempOrderBookStreamBuffer.get(message.s);
          tempOrderBook!.set(message.u, message);
          return;
        }

        const exchangeInfo = this.exchangeInfoMap.get(message.s);
        if (!exchangeInfo) return console.log(`Cannot find binance market info..`);

        this.updateOrderBook(exchangeInfo.baseAsset, exchangeInfo.quoteAsset, OrderType.bid, message.b);
        this.updateOrderBook(exchangeInfo.baseAsset, exchangeInfo.quoteAsset, OrderType.ask, message.a);
        break;
      }
    }
  }
}

class BinanceWSConnector extends WSConnector {
  constructor(url: string) {
    super(url);

    // this.on("message", (message: any) => {
    //   console.dir(JSON.parse(message.data));
    //   // this.emit("message", JSON.parse(message.data));
    // });
  }
}

interface BinanceExchangeInformation {
  symbol: string;
  status: string;
  baseAsset: string;
  baseAssetPrecision: number;
  quoteAsset: string;
  quoteAssetPrecision: number;
  filters: any[];
}
