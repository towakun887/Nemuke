//js for Chirimen raspberry pi zero
import { requestI2CAccess } from "./node_modules/node-web-i2c/index.js";
import {requestGPIOAccess} from "./node_modules/node-web-gpio/dist/index.js";
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import SCD40 from "@chirimen/scd40";
import NPIX from "@chirimen/neopixel-i2c";

const sleep = (msec) => new Promise((resolve) => setTimeout(resolve, msec));

const TARGET_URL = "https://script.google.com/macros/s/*****/exec";
const BUZZER_URL = "https://script.google.com/macros/s/*****/exec?function=getAlarmFlagStatus";

let npix = null;
const neoPixels = 8; // LED個数

let scd40 = null;
let jinkan_port = null;
let led_port = null;
let buzzer_port = null;

const PORT_PATH = '/dev/ttyUSB0'; // 接続したUSBシリアルデバイスのパス
const BAUD_RATE = 9600;           // デバイスのボーレート

let gps_active = false;
let gps_data_cache = {
    isValid: false,
    latitude: 0,
    longitude: 0,
    timestamp: 0
};

await init();
// 初回測定データが利用可能になるまで待機（SCD40の仕様に依存）
await sleep(5000); 
sencingPost();
setInterval(sencingPost, 20000);
setInterval(getBuzzerSelfActiveState, 2500);

// アラートの目標状態（点滅させるべきか、ブザーを鳴らすべきか）
let alertCycleActive = false;
let isBlinking = false;
let isBuzzerActive = false;
let isBuzzerSituationActive = false;
let isBuzzerSelfActive = false;

// 物理的なライトの現在の状態（点滅サイクルのために必要）
let buzzerState = false;
let lightBlinkState = false;
let lightSignalStatus = [0,0];

async function init() {//written by mostly Human

    const gps_port = new SerialPort({
        path: PORT_PATH,
        baudRate: BAUD_RATE
    });

    // ポートが開いたときの処理
    gps_port.on('open', () => {
        gps_active = true;
        console.log('ポートオープン成功。GPSデータの受信待機中...');
    });
    // エラー処理
    gps_port.on('error', (err) => {
        gps_active = false;
        console.error('シリアルポートエラー:', err.message);
    });
    // Readlineパーサーを使用して、改行ごとにデータを処理
    const parser = gps_port.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', line => {
        const result = parseNmeaSentence(line.trim());
        if (result) {
            // 受信した最新のGPSデータをキャッシュに保存
            gps_data_cache.isValid = result.isValid;
            if (result.isValid) {
                gps_data_cache.latitude = result.latitude;
                gps_data_cache.longitude = result.longitude;
                gps_data_cache.timestamp = Math.floor(Date.now() / 1000);
            }
        }
    });

	const i2cAccess = await requestI2CAccess();
	const i2c_port = i2cAccess.ports.get(1);
	scd40 = new SCD40(i2c_port, 0x62);
	await scd40.init();
	console.log("SCD40 Serial Number:", await scd40.serial_number());
	await scd40.start_periodic_measurement();

    npix = new NPIX(i2c_port, 0x41);
    await npix.init(neoPixels);
    await npix.setGlobal(0, 0, 0);

    const gpioAccess = await requestGPIOAccess();

    jinkan_port = gpioAccess.ports.get(18);//jinkan
    await jinkan_port.export("in");

    led_port = gpioAccess.ports.get(4);//led
    await led_port.export("out");

    buzzer_port = gpioAccess.ports.get(23);//buzzer
    await buzzer_port.export("out");

    await led_port.write(1);
    await buzzer_port.write(1);
    await sleep(50);
    await buzzer_port.write(0);
    await sleep(10);
    await buzzer_port.write(1);
    await sleep(50);
    await buzzer_port.write(0);
}

async function sencingPost(){//written by Human and Gemini
    try {
        console.log("data collecting...");
        const current_timestamp_sec = Math.floor(Date.now() / 1000);

        const exist_gps = gps_active ? (gps_data_cache.isValid && (current_timestamp_sec - gps_data_cache.timestamp<23)) : false;
        const gps_lat = gps_active ? gps_data_cache.latitude : null;
        const gps_long = gps_active ? gps_data_cache.longitude : null;

        // 1. SCD40からデータ取得
        const scd_data = await scd40.getData();
        const co2_concentration = scd_data.co2;
        const temp = scd_data.temperature;
        const humid = scd_data.relative_humidity;

        const exist_co2 = (co2_concentration != null && !isNaN(co2_concentration));
        const exist_temp = (temp != null && !isNaN(temp));
        const exist_humid = (humid != null && !isNaN(humid));

        const presence = await jinkan_port.read();

        await checkSignalSituation(approximateWBGT(temp,humid),co2_concentration);

        // 2. ご指定のJSONフォーマットに合わせてデータオブジェクトを作成
        const payload = {
            "data": [
                    {
                        "isValueExists": {
                            "timestamp": true,
                            "gps": exist_gps,
                            "co2": exist_co2,
                            "temp": exist_temp,
                            "humid": exist_humid,
                            "driver": true,
                            "presence": true
                        },
                        "values": {
                            "timestamp": current_timestamp_sec,
                            "lat": gps_lat,
                            "lng": gps_long,
                            "co2": co2_concentration,
                            "temp": temp,
                            "humid": humid,
                            "driver": (presence>0 ? true : false),
                            "presence": (presence>0 ? true : false)
                        }
                    }
                ]
        };

        console.log(`[${new Date().toISOString()}] Sending data:`, payload);

        // 3. 指定のURLへPOSTでJSONを送信
        await postData(TARGET_URL, payload);
        
    } catch (error) {
        console.error("Error during measurement or POST request:", error);
        // エラーが発生した場合、last_sent_timestampは更新せず、再試行を待ちます
    }
}

async function runAlertCycle() {
    alertCycleActive = true;
    if (!isBlinking && !isBuzzerActive){
        alertCycleActive = false;
        await decideRgb(lightSignalStatus[0],lightSignalStatus[1]);
        await buzzer_port.write(0);
        return;
    }

    // 【ライト制御ロジック】
    if (isBlinking || isBuzzerActive) {
        lightBlinkState = !lightBlinkState; // ON/OFF反転
        await npix.setGlobal(lightBlinkState ? 255 : 0, 0, 0);
    } else {
        // isBlinkingがfalseなら強制OFF
        await decideRgb(lightSignalStatus[0],lightSignalStatus[1]);
    }

    // 【ブザー制御ロジック】
    if (isBuzzerActive) {
        buzzerState = !buzzerState;
        await buzzer_port.write(buzzerState ? 1 : 0);
    } else {
        await buzzer_port.write(0);
    }
    
    setTimeout(runAlertCycle, 500); // 0.5秒後に次を予約
}

async function checkSignalSituation(wbgt,co2) {
    if(wbgt > 35 || co2 > 20000){
        isBuzzerSituationActive = true;
        if(isBuzzerSelfActive || isBuzzerSituationActive){
            isBuzzerActive = true;
            if(!alertCycleActive) runAlertCycle();
        }
        return;
    }else{
        if (isBuzzerActive) {
            isBuzzerSituationActive = false;
            if(!(isBuzzerSelfActive || isBuzzerSituationActive)){
                isBuzzerActive = false;
            }
        }
    }
    if (wbgt > 30 || co2 > 10000) {
        isBlinking = true;
        if(!alertCycleActive) runAlertCycle();
    }else{
        if(isBlinking){
            isBlinking = false;
        }
    }
    const wbgtline = [0,20,22,24,26,28]
    for (var i = 5; i >= 0; i--) {
        if(i==0){
            lightSignalStatus[0] = 0;
            break;
        }
        if(wbgt > wbgtline[i]){
            lightSignalStatus[0] = i;
            break;
        }
    }
    const co2line = [0,500,1000,2500,4000,5000]
    for (var i = 5; i >= 0; i--) {
        if(i==0){
            lightSignalStatus[1] = 0;
            break;
        }
        if(co2 > co2line[i]){
            lightSignalStatus[1] = i;
            break;
        }
    }
    decideRgb(lightSignalStatus[0],lightSignalStatus[1]);
}

//NEOPIXEL

const signalG = [0x008000, 0x004000, 0x002000, 0x001000];//brightest,dimmer,dimmer,dimmest
const signalY = [0x422c00, 0x1e1400];
const signalR = 0x800000;
const signalRMAX = 0xff0000;
//1=G,2=Y,3=R
const signal = [[1, 0, 0, 1], [0, 0, 0, 1], [2, 0, 0, 1], [0, 0, 2, 0], [2, 0, 0, 2], [0, 3, 0, 0]];

async function setPattern(pattern) {//copied from chirimen NPIX library
    // パターン設定
    const grbArray = [];
    for (const color of pattern) {
        const r = color >> 16 & 0xff;
        const g = color >> 8 & 0xff;
        const b = color & 0xff;
        grbArray.push(g);
        grbArray.push(r);
        grbArray.push(b);
    }
    await npix.setPixels(grbArray);
}

async function decideRgb(wbgtSignal, co2Signal, cds = 500) {
    const sendRgb = [];
    const rygValue = [0, 0, 0, signalR];
    if (cds < 200) {
        rygValue[1] = signalG[0];
        rygValue[2] = signalY[0];
    } else if (cds < 400) {
        rygValue[1] = signalG[1];
        rygValue[2] = signalY[0];
    } else if (cds < 600) {
        rygValue[1] = signalG[2];
        rygValue[2] = signalY[1];
    } else {//cds >= 600
        rygValue[1] = signalG[3];
        rygValue[2] = signalY[1];
    }
    console.log(rygValue);
    for (var i = 0; i < 4; i++) {
        sendRgb.push(rygValue[signal[wbgtSignal][i]]);
    }
    for (var i = 0; i < 4; i++) {
        sendRgb.push(rygValue[signal[co2Signal][i]]);
    }
    console.log(sendRgb);
    await setPattern(sendRgb);
}

function approximateWBGT(T, RH) {//Written by Gemini
    // 1. Tに関する項 (0.735 * T + 0.00657 * T)
    const termT = (0.735 + 0.00657) * T;
    
    // 2. RHに関する線形項
    const termRHLinear = 0.0276 * RH;
    
    // 3. RHに関する指数項
    const termRHExp = 0.401 * Math.exp(-0.00517 * RH);
    
    // 4. 定数項
    const constantTerm = -3.70;

    const WBGT = termT + termRHLinear + termRHExp + constantTerm;

    // 小数点第1位などで丸める場合は以下を使用
    return Math.round(WBGT * 100) / 100;
}

// -----------------------------------------------
// NMEAパーサー関数
// -----------------------------------------------

/**
 * NMEAフォーマットの緯度または経度を十進数（度）に変換します。
 * @param {string} rawData ddmm.mmmm または dddmm.mmmm 形式の生データ
 * @param {string} direction N, S, E, W の方向指示子
 * @returns {number|null} 十進数形式の度
 * written by Gemini
 */
function convertNmeaToDecimal(rawData, direction) {
    if (!rawData) return null;

    // rawDataが文字列の場合を考慮し、数値に変換
    const numData = parseFloat(rawData);
    
    // ddmm.mmmm または dddmm.mmmm 形式から度と分を分離
    const degrees = Math.floor(numData / 100);
    const minutes = numData % 100;
    let decimal = degrees + minutes / 60;

    // 南緯 (S) や西経 (W) の場合は負の値にする
    if (direction === 'S' || direction === 'W') {
        decimal = -decimal;
    }

    // 少数点以下6桁の精度で返す
    return parseFloat(decimal.toFixed(6));
}

/**
 * 受信したNMEAセンテンスを解析し、緯度・経度と有効性を抽出します。
 * @param {string} sentence 受信したNMEAセンテンスの文字列
 * @returns {{latitude: number|null, longitude: number|null, isValid: boolean}|null} 解析結果
 * written by Gemini
 */
function parseNmeaSentence(sentence) {
    // $GNRMC または $GPRMC センテンスのみを処理
    if (!sentence.startsWith('$GNRMC') && !sentence.startsWith('$GPRMC')) {
        return null;
    }

    const parts = sentence.split(',');

    // RMCセンテンスのフィールド数チェック (最低限12フィールド)
    if (parts.length < 12) {
        return null;
    }

    // フィールド3: データ有効性 (A=有効, V=無効)
    const status = parts[2];
    
    const result = {
        latitude: null,
        longitude: null,
        isValid: status === 'A'
    };

    // データが有効な場合のみ緯度経度を抽出
    if (result.isValid) {
        const latRaw = parts[3];
        const latDir = parts[4];
        const lonRaw = parts[5];
        const lonDir = parts[6];

        if (latRaw && latDir && lonRaw && lonDir) {
            result.latitude = convertNmeaToDecimal(latRaw, latDir);
            result.longitude = convertNmeaToDecimal(lonRaw, lonDir);
        }
    }

    return result;
}

async function getBuzzerSelfActiveState(){
    // 読みやすさを重視した推奨される書き方
    fetch(BUZZER_URL)
        .then(response => {
            if (!response.ok) {
                throw new Error('HTTPエラー');
            }
            return response.text();
        })
        .then(text => {
            if(text=='TRUE'){
                isBuzzerSelfActive = true;
                if(isBuzzerSelfActive || isBuzzerSituationActive){
                    isBuzzerActive = true;
                    if(!alertCycleActive) runAlertCycle();
                }
                
            }else if(text=='FALSE'){
                isBuzzerSelfActive = false;
                if(!(isBuzzerSelfActive || isBuzzerSituationActive)){
                    isBuzzerActive = false;
                }
            }
        })
        .catch(error => console.error(error));
}

/**
 * 指定のURLにJSONデータをPOST送信する関数
 * written by Gemini
 */
async function postData(url, data) {
    try {
        const response = await fetch(url, {
            method: 'POST', 
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data), 
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        console.log(JSON.stringify(data));
        console.log("Data successfully posted. Server response status:", response.status);

    } catch (error) {
        console.error("POST request failed:", error.message);
    }
}
