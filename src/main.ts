import moment from 'moment';
import { Script } from "@script_types/script/script";
import { ScriptConfig } from "../gen/spec_config";
import { ScriptCtxUI } from "@script_types/script/context_ui/context_ui";
import { specification } from './spec';
import { SourceWebcamImage } from '@script_types/sources/media/source_webcam_image';

export class Instance {
    private ctx: Script.Context;
    private config: ScriptConfig;

    private fetch_test_interval_: NodeJS.Timeout | undefined;
    private t_last_data_ms: number | undefined;
    
    private promise_fetching: Promise<void> | undefined;
    private last_data: SourceWebcamImage.Data | undefined;

    private stopped = false;
    private fetch_num = 0;
    
    constructor(ctx: Script.Context, config: ScriptConfig) {
        this.ctx = ctx;
        this.config = config;

        console.info("Ident:" + specification.id_ident);
        console.info("Config:", this.config);

        this.ctx.data.assets.init({
            expiry_ms: 60 * 60 * 1000, // Max 1 hour
            max_entry_count: 12
        })
    }

    public start = async () => {

        if (this.config.webcam) {
            const error = this.ctx.ui.subscribeVisibilityChanges("webcam_image", this.visibilityChanged);
            if (error) {
                console.error(error);
            }
        } else {
            console.error("'webcam' not defined in config");
        }

        const handleSubscriptionResult = (result: { error: string | undefined }) => {
            if (result.error) console.error(result.error);
        }
        this.ctx.ui.subscribeDataRequests<"webcam_image">("webcam_image", this.dataRequestWebcamImage).then(handleSubscriptionResult);

        console.log("Start done!");
    }

    public stop = async (_reason: Script.StopReason): Promise<void> => {
        console.info("Stopping all my stuff ...");
        this.stopped = true;
    }

      
    private visibilityChanged: ScriptCtxUI.VisibilityChangeCallback = (change_o) => {
        console.log("visibilityChanged: " + change_o.state_new);
        if (change_o.state_new == "SLEEP") {
            if (this.fetch_test_interval_) {
                clearInterval(this.fetch_test_interval_);
                this.fetch_test_interval_ = undefined;
            } 
        } else {
            if (!this.fetch_test_interval_) {
                this.testDataFetch(true);
                this.fetch_test_interval_ = setInterval(() => { this.testDataFetch(false); }, 15 * 1000);
            }
        }
    }

    private testDataFetch = async (force_fetch?: boolean) => {
        const m_now = moment();
        
        let min = Math.floor(m_now.minutes());
        const mod_10 = min % 10;
        let min_10 = min - mod_10;

        // Image always at full 10 Minutes, try to fetch from
        const in_relevant_min_after = mod_10 == 2 || mod_10 == 3;
        const since_last_ms =  this.t_last_data_ms ? Date.now() - this.t_last_data_ms : undefined;
        const need_time = since_last_ms === undefined || since_last_ms > (5 * 60 * 1000);
        const do_fetch = since_last_ms === undefined || (in_relevant_min_after && need_time);

        console.debug(`testFetch, relevantTimeframe: [ ${in_relevant_min_after} ], since: [ ${since_last_ms} ] ms, need_time [ ${need_time} ] => ${do_fetch} `);
        if (do_fetch || (force_fetch && need_time)) {
            let m_data = m_now.clone();
            m_data.minute(min_10);
            if ((since_last_ms === undefined || force_fetch) && (mod_10 == 0 || mod_10 == 1)) { // => not in timeframe for "current image" => go 10 minutes back!
                m_data.add(-10, "minutes"); 
            }
            m_data.second(0);
            const to_data_ms = m_now.valueOf() - m_data.valueOf();
            if (to_data_ms >= 15 * 1000 && this.config && this.config.webcam) {
                // https://www.foto-webcam.eu/webcam/gantkofel/2021/05/16/0740_hd.jpg
                let date_url = m_data.format("YYYY/MM/DD/HHmm");
                let url_base = "https://www.foto-webcam.org/webcam/";
               
                let m = this.config.webcam.req_url.match(/(https:\/\/([^\/]+)\/webcam\/)([^\/]+)/);
                if (m) {
                    url_base = m[1];
                    console.debug(`url_base found: ${url_base}`);
                }
                let req_url = url_base + this.config.webcam.value + "/" + date_url + "_hd.jpg";

                this.promise_fetching = this.dataRequest_ImageWebcam(req_url, m_data.valueOf());
                // http://www.foto-webcam.org/webcam/wallberg/2021/05/19/0120_hd.jpg
            } else {
                console.debug(`testFetch, do not fetch as [ ${to_data_ms} ] < 15000 or missing config`);
            }
        }
    }

    // Called when e.g. a screen changed or a second display connects => only return the last fetched
    private dataRequestWebcamImage: ScriptCtxUI.DataRequestCallback<"webcam_image">  = async (_req_params: object) => {
        console.debug(`dataRequest`);
        if (this.promise_fetching) {
            await this.promise_fetching;
        }
        return this.last_data;
    }

      /*
     HttpErrorCode: UNABLE_TO_VERIFY_LEAF_SIGNATURE: RequestError: unable to verify the first certificate
        01:33:22.323INFOInstVaxMu9Get https://www.foto-webcam.org/webcam/wallberg/2021/05/19/0130_hd.jpg
    */

        public dataRequest_ImageWebcam = async (url: string, t_image: number) => {
            this.fetch_num ++;
            console.log(`GetData [ ${this.fetch_num} ] [ ${url} ] ...`);
            this.ctx.ui.informDataLoading("webcam_image");
            
            try {
                const result = await this.ctx?.data.http.getRaw(url, 5000, {}, { strictSSL: false })
                if (result  && result.statusCode == 200 && result.body) {
                    
                    this.t_last_data_ms = t_image; // Remember the last data time!
                    
                    // Send the image:
                    console.log(`GetData [ ${this.fetch_num} ] => got data after [ ${result.exec_ms} ] ms, transmit to GUI`);
                    const uid = "img_" + url;
                    this.ctx?.data.assets.insert({
                        uid,
                        base64: result.body.toString("base64"),
                        type: "jpg"
                    });
                    const data: SourceWebcamImage.Data = {
                        image: {
                            asset_uid: uid,
                            filename: "now.jpg"
                        },
                        time_ms: t_image
                    };
                    this.last_data = data;
                    this.ctx.ui.transmitData("webcam_image", data);
                    this.promise_fetching = undefined;
                } else {
                    console.error("GetError: " + result?.error);
                }
            } catch(e) {
                // Error might happen in case request happens just the moment the script is stopped! Let's catch it and do nothing afterwards.
                if (!this.stopped) {
                    console.warn("GetData, datched error at http.get: ", e);
                }
            };
        }
}