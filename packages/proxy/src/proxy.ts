import JSONStream from 'JSONStream';
import buildDebug from 'debug';
import fs from 'fs';
import got, { Headers as gotHeaders } from 'got';
import type { Agents, Options } from 'got';
import type { Agent as AgentHTTP } from 'http';
import type { Agent as AgentHTTPS } from 'https';
import _ from 'lodash';
import ProxyAgent from 'proxy-agent';
import requestDeprecated from 'request';
import Stream, { PassThrough, Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { Headers, fetch as undiciFetch } from 'undici';
import { URL } from 'url';

import {
  API_ERROR,
  CHARACTER_ENCODING,
  HEADERS,
  HEADER_TYPE,
  HTTP_STATUS,
  TOKEN_BASIC,
  TOKEN_BEARER,
  constants,
  errorUtils,
  searchUtils,
  validatioUtils,
} from '@verdaccio/core';
import { ReadTarball } from '@verdaccio/streams';
import { Manifest } from '@verdaccio/types';
import { Callback, Config, IReadTarball, Logger, UpLinkConf } from '@verdaccio/types';
import { buildToken } from '@verdaccio/utils';

import { parseInterval } from './proxy-utils';

const LoggerApi = require('@verdaccio/logger');

const debug = buildDebug('verdaccio:proxy');

const encode = function (thing): string {
  return encodeURIComponent(thing).replace(/^%40/, '@');
};

const jsonContentType = HEADERS.JSON;
const contentTypeAccept = `${jsonContentType};`;

/**
 * Just a helper (`config[key] || default` doesn't work because of zeroes)
 */
const setConfig = (config, key, def): string => {
  return _.isNil(config[key]) === false ? config[key] : def;
};

export type UpLinkConfLocal = UpLinkConf & {
  no_proxy?: string;
};

export interface ProxyList {
  [key: string]: IProxy;
}

export type ProxySearchParams = {
  headers?: Headers;
  url: string;
  query?: searchUtils.SearchQuery;
  abort: AbortController;
};
export interface IProxy {
  config: UpLinkConfLocal;
  failed_requests: number;
  userAgent: string;
  ca?: string | void;
  logger: Logger;
  server_id: string;
  url: URL;
  maxage: number;
  timeout: number;
  max_fails: number;
  fail_timeout: number;
  upname: string;
  fetchTarball(url: string): IReadTarball;
  search(options: ProxySearchParams): Promise<Stream.Readable>;
  getRemoteMetadata(name: string, options: any, callback: Callback): void;
  getRemoteMetadataNext(name: string, options: ISyncUplinksOptions): Promise<[Manifest, string]>;
}

export interface ISyncUplinksOptions extends Options {
  uplinksLook?: boolean;
  etag?: string;
  remoteAddress?: string;
}

/**
 * Implements Storage interface
 * (same for storage.js, local-storage.js, up-storage.js)
 */
class ProxyStorage implements IProxy {
  public config: UpLinkConfLocal;
  public failed_requests: number;
  public userAgent: string;
  public ca: string | void;
  public logger: Logger;
  public server_id: string;
  public url: URL;
  public maxage: number;
  public timeout: number;
  public max_fails: number;
  public fail_timeout: number;
  public agent_options: any;
  // FIXME: upname is assigned to each instance
  // @ts-ignore
  public upname: string;
  public proxy: string | undefined;
  private agent: Agents | undefined;
  // @ts-ignore
  public last_request_time: number | null;
  public strict_ssl: boolean;

  /**
   * Constructor
   * @param {*} config
   * @param {*} mainConfig
   */
  public constructor(config: UpLinkConfLocal, mainConfig: Config) {
    this.config = config;
    this.failed_requests = 0;
    this.userAgent = mainConfig.user_agent;
    this.ca = config.ca;
    this.logger = LoggerApi.logger.child({ sub: 'out' });
    this.server_id = mainConfig.server_id;
    this.agent_options = setConfig(this.config, 'agent_options', {
      keepAlive: true,
      maxSockets: 40,
      maxFreeSockets: 10,
    });
    this.url = new URL(this.config.url);
    const isHTTPS = this.url.protocol === 'https:';
    this._setupProxy(this.url.hostname, config, mainConfig, isHTTPS);
    if (typeof this.proxy === 'string') {
      // TODO: pending hook agent_options options
      this.agent = isHTTPS
        ? { https: new ProxyAgent(this.proxy) as AgentHTTPS }
        : { http: new ProxyAgent(this.proxy) as AgentHTTP };
    }
    this.config.url = this.config.url.replace(/\/$/, '');

    if (this.config.timeout && Number(this.config.timeout) >= 1000) {
      this.logger.warn(
        [
          'Too big timeout value: ' + this.config.timeout,
          'We changed time format to nginx-like one',
          '(see http://nginx.org/en/docs/syntax.html)',
          'so please update your config accordingly',
        ].join('\n')
      );
    }

    // a bunch of different configurable timers
    this.maxage = parseInterval(setConfig(this.config, 'maxage', '2m'));
    this.timeout = parseInterval(setConfig(this.config, 'timeout', '30s'));
    this.max_fails = Number(setConfig(this.config, 'max_fails', 2));
    this.fail_timeout = parseInterval(setConfig(this.config, 'fail_timeout', '5m'));
    this.strict_ssl = Boolean(setConfig(this.config, 'strict_ssl', true));
  }

  /**
   * Fetch an asset.
   * @param {*} options
   * @param {*} cb
   * @return {Request}
   * @deprecated do not use
   */
  private request(options: any, cb?: Callback): Stream.Readable {
    let json;

    if (this._statusCheck() === false) {
      const streamRead = new Stream.Readable();

      process.nextTick(function (): void {
        if (cb) {
          cb(errorUtils.getInternalError(errorUtils.API_ERROR.UPLINK_OFFLINE));
        }
        streamRead.emit('error', errorUtils.getInternalError(errorUtils.API_ERROR.UPLINK_OFFLINE));
      });
      streamRead._read = function (): void {};
      // preventing 'Uncaught, unspecified "error" event'
      streamRead.on('error', function (): void {});
      return streamRead;
    }

    const self = this;
    const headers: Headers = this._setHeaders(options);

    this._addProxyHeaders(options.req, headers);
    this._overrideWithUpLinkConfLocaligHeaders(headers);

    const method = options.method || 'GET';
    const uri = options.uri_full || this.config.url + options.uri;

    self.logger.info(
      {
        method: method,
        headers: headers,
        uri: uri,
      },
      "making request: '@{method} @{uri}'"
    );

    if (validatioUtils.isObject(options.json)) {
      json = JSON.stringify(options.json);
      headers['Content-Type'] = headers['Content-Type'] || HEADERS.JSON;
    }

    const requestCallback = cb
      ? function (err, res, body): void {
          let error;
          const responseLength = err ? 0 : body.length;
          processBody();
          logActivity();
          cb(err, res, body);

          /**
           * Perform a decode.
           */
          function processBody(): void {
            if (err) {
              error = err.message;
              return;
            }

            if (options.json && res.statusCode < 300) {
              try {
                // $FlowFixMe
                body = JSON.parse(body.toString(CHARACTER_ENCODING.UTF8));
              } catch (_err: any) {
                body = {};
                err = _err;
                error = err.message;
              }
            }

            if (!err && validatioUtils.isObject(body)) {
              if (_.isString(body.error)) {
                error = body.error;
              }
            }
          }
          /**
           * Perform a log.
           */
          function logActivity(): void {
            let message = "@{!status}, req: '@{request.method} @{request.url}'";
            // FIXME: use LOG_VERDACCIO_BYTES
            message += error ? ', error: @{!error}' : ', bytes: @{bytes.in}/@{bytes.out}';
            self.logger.http(
              {
                // if error is null/false change this to undefined so it wont log
                err: err || undefined,
                request: { method: method, url: uri },
                status: res != null ? res.statusCode : 'ERR',
                error: error,
                bytes: {
                  in: json ? json.length : 0,
                  out: responseLength || 0,
                },
              },
              message
            );
          }
        }
      : undefined;

    let requestOptions = {
      url: uri,
      method: method,
      headers: headers,
      body: json,
      proxy: this.proxy,
      encoding: null,
      gzip: true,
      timeout: this.timeout,
      strictSSL: this.strict_ssl,
      agentOptions: this.agent_options,
    };

    if (typeof this.ca === 'string') {
      requestOptions = Object.assign({}, requestOptions, {
        ca: fs.readFileSync(this.ca),
      });
    }

    const req = requestDeprecated(requestOptions, requestCallback);

    let statusCalled = false;
    req.on('response', function (res): void {
      // FIXME: _verdaccio_aborted seems not used
      // @ts-ignore
      if (!req._verdaccio_aborted && !statusCalled) {
        statusCalled = true;
        self._statusCheck(true);
      }

      if (_.isNil(requestCallback) === false) {
        (function do_log(): void {
          const message = "@{!status}, req: '@{request.method} @{request.url}' (streaming)";
          self.logger.http(
            {
              request: {
                method: method,
                url: uri,
              },
              status: _.isNull(res) === false ? res.statusCode : 'ERR',
            },
            message
          );
        })();
      }
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    req.on('error', function (_err): void {
      // FIXME: _verdaccio_aborted seems not used
      // @ts-ignore
      if (!req._verdaccio_aborted && !statusCalled) {
        statusCalled = true;
        self._statusCheck(false);
      }
    });
    // @ts-ignore
    return req;
  }

  /**
   * Set default headers.
   * @param {Object} options
   * @return {Object}
   * @private
   * @deprecated use getHeadersNext
   */
  private _setHeaders(options: any): Headers {
    const headers = options.headers || {};
    const accept = HEADERS.ACCEPT;
    const acceptEncoding = HEADERS.ACCEPT_ENCODING;
    const userAgent = HEADERS.USER_AGENT;

    headers[accept] = headers[accept] || contentTypeAccept;
    headers[acceptEncoding] = headers[acceptEncoding] || 'gzip';
    // registry.npmjs.org will only return search result if user-agent include string 'npm'
    headers[userAgent] = headers[userAgent] || `npm (${this.userAgent})`;

    return this._setAuth(headers);
  }

  private getHeadersNext(headers = {}): gotHeaders {
    const accept = HEADERS.ACCEPT;
    const acceptEncoding = HEADERS.ACCEPT_ENCODING;
    const userAgent = HEADERS.USER_AGENT;

    headers[accept] = headers[accept] || contentTypeAccept;
    headers[acceptEncoding] = headers[acceptEncoding] || 'gzip';
    // registry.npmjs.org will only return search result if user-agent include string 'npm'
    headers[userAgent] = headers[userAgent] || `npm (${this.userAgent})`;

    return this.setAuthNext(headers);
  }

  /**
   * Validate configuration auth and assign Header authorization
   * @param {Object} headers
   * @return {Object}
   * @private
   */
  private _setAuth(headers: any): Headers {
    const { auth } = this.config;

    if (_.isNil(auth) || headers[HEADERS.AUTHORIZATION]) {
      return headers;
    }

    if (_.isObject(auth) === false && _.isObject(auth.token) === false) {
      this._throwErrorAuth('Auth invalid');
    }

    // get NPM_TOKEN http://blog.npmjs.org/post/118393368555/deploying-with-npm-private-modules
    // or get other variable export in env
    // https://github.com/verdaccio/verdaccio/releases/tag/v2.5.0
    let token: any;
    const tokenConf: any = auth;

    if (_.isNil(tokenConf.token) === false && _.isString(tokenConf.token)) {
      token = tokenConf.token;
    } else if (_.isNil(tokenConf.token_env) === false) {
      if (_.isString(tokenConf.token_env)) {
        token = process.env[tokenConf.token_env];
      } else if (_.isBoolean(tokenConf.token_env) && tokenConf.token_env) {
        token = process.env.NPM_TOKEN;
      } else {
        this.logger.error(constants.ERROR_CODE.token_required);
        this._throwErrorAuth(constants.ERROR_CODE.token_required);
      }
    } else {
      token = process.env.NPM_TOKEN;
    }

    if (_.isNil(token)) {
      this._throwErrorAuth(constants.ERROR_CODE.token_required);
    }

    // define type Auth allow basic and bearer
    const type = tokenConf.type || TOKEN_BASIC;
    this._setHeaderAuthorization(headers, type, token);

    return headers;
  }

  /**
   * Validate configuration auth and assign Header authorization
   * @param {Object} headers
   * @return {Object}
   * @private
   */
  private setAuthNext(headers: gotHeaders): gotHeaders {
    const { auth } = this.config;

    if (_.isNil(auth) || headers[HEADERS.AUTHORIZATION]) {
      return headers;
    }

    if (_.isObject(auth) === false && _.isObject(auth.token) === false) {
      this._throwErrorAuth('Auth invalid');
    }

    // get NPM_TOKEN http://blog.npmjs.org/post/118393368555/deploying-with-npm-private-modules
    // or get other variable export in env
    // https://github.com/verdaccio/verdaccio/releases/tag/v2.5.0
    let token: any;
    const tokenConf: any = auth;

    if (_.isNil(tokenConf.token) === false && _.isString(tokenConf.token)) {
      token = tokenConf.token;
    } else if (_.isNil(tokenConf.token_env) === false) {
      if (_.isString(tokenConf.token_env)) {
        token = process.env[tokenConf.token_env];
      } else if (_.isBoolean(tokenConf.token_env) && tokenConf.token_env) {
        token = process.env.NPM_TOKEN;
      } else {
        this.logger.error(constants.ERROR_CODE.token_required);
        this._throwErrorAuth(constants.ERROR_CODE.token_required);
      }
    } else {
      token = process.env.NPM_TOKEN;
    }

    if (_.isNil(token)) {
      this._throwErrorAuth(constants.ERROR_CODE.token_required);
    }

    // define type Auth allow basic and bearer
    const type = tokenConf.type || TOKEN_BASIC;
    this._setHeaderAuthorization(headers, type, token);

    return headers;
  }

  /**
   * @param {string} message
   * @throws {Error}
   * @private
   */
  private _throwErrorAuth(message: string): Error {
    this.logger.error(message);
    throw new Error(message);
  }

  /**
   * Assign Header authorization with type authentication
   * @param {Object} headers
   * @param {string} type
   * @param {string} token
   * @private
   */
  private _setHeaderAuthorization(headers: any, type: string, token: any): void {
    const _type: string = type.toLowerCase();

    if (_type !== TOKEN_BEARER.toLowerCase() && _type !== TOKEN_BASIC.toLowerCase()) {
      this._throwErrorAuth(`Auth type '${_type}' not allowed`);
    }

    type = _.upperFirst(type);
    headers[HEADERS.AUTHORIZATION] = buildToken(type, token);
  }

  /**
   * It will add or override specified headers from config file.
   *
   * Eg:
   *
   * uplinks:
   npmjs:
   url: https://registry.npmjs.org/
   headers:
   Accept: "application/vnd.npm.install-v2+json; q=1.0"
   verdaccio-staging:
   url: https://mycompany.com/npm
   headers:
   Accept: "application/json"
   authorization: "Basic YourBase64EncodedCredentials=="

   * @param {Object} headers
   * @private
   * @deprecated use applyUplinkHeaders
   */
  private _overrideWithUpLinkConfLocaligHeaders(headers: Headers): any {
    if (!this.config.headers) {
      return headers;
    }

    // add/override headers specified in the config
    /* eslint guard-for-in: 0 */
    for (const key in this.config.headers) {
      headers[key] = this.config.headers[key];
    }
  }

  private applyUplinkHeaders(headers: gotHeaders): gotHeaders {
    if (!this.config.headers) {
      return headers;
    }

    // add/override headers specified in the config
    /* eslint guard-for-in: 0 */
    for (const key in this.config.headers) {
      headers[key] = this.config.headers[key];
    }
    return headers;
  }

  public async getRemoteMetadataNext(
    name: string,
    options: ISyncUplinksOptions
  ): Promise<[Manifest, string]> {
    if (this._ifRequestFailure()) {
      throw errorUtils.getInternalError(API_ERROR.UPLINK_OFFLINE);
    }

    // FUTURE: allow mix headers that comes from the client
    debug('get metadata for %s', name);
    let headers = this.getHeadersNext(options?.headers);
    headers = this.addProxyHeadersNext(headers, options.remoteAddress);
    headers = this.applyUplinkHeaders(headers);
    // the following headers cannot be overwritten
    if (_.isNil(options.etag) === false) {
      headers[HEADERS.NONE_MATCH] = options.etag;
      headers[HEADERS.ACCEPT] = contentTypeAccept;
    }
    const method = options.method || 'GET';
    const uri = this.config.url + `/${encode(name)}`;
    debug('request uri for %s', uri);
    let response;
    let responseLength = 0;
    try {
      response = await got(uri, {
        headers,
        responseType: 'json',
        method,
        agent: this.agent,
        // FIXME: this should be taken from construtor as priority
        retry: options?.retry,
        timeout: options?.timeout,
        hooks: {
          afterResponse: [
            (afterResponse) => {
              const code = afterResponse.statusCode;
              if (code >= HTTP_STATUS.OK && code < HTTP_STATUS.MULTIPLE_CHOICES) {
                if (this.failed_requests >= this.max_fails) {
                  this.failed_requests = 0;
                  this.logger.warn(
                    {
                      host: this.url.host,
                    },
                    'host @{host} is now online'
                  );
                }
              }

              return afterResponse;
            },
          ],
          beforeRetry: [
            // FUTURE: got 12.0.0, the option arg should be removed
            (_options, error: any, count) => {
              this.failed_requests = count ?? 0;
              this.logger.info(
                {
                  request: {
                    method: method,
                    url: uri,
                  },
                  error: error.message,
                  retryCount: this.failed_requests,
                },
                "retry @{retryCount} req: '@{request.method} @{request.url}'"
              );
              if (this.failed_requests >= this.max_fails) {
                this.logger.warn(
                  {
                    host: this.url.host,
                  },
                  'host @{host} is now offline'
                );
              }
            },
          ],
        },
      })
        .on('request', () => {
          this.last_request_time = Date.now();
        })
        .on('response', (eventResponse) => {
          const message = "@{!status}, req: '@{request.method} @{request.url}' (streaming)";
          this.logger.http(
            {
              request: {
                method: method,
                url: uri,
              },
              status: _.isNull(eventResponse) === false ? eventResponse.statusCode : 'ERR',
            },
            message
          );
        })
        .on('downloadProgress', (progress) => {
          if (progress.total) {
            responseLength = progress.total;
          }
        });
      const etag = response.headers.etag as string;
      const data = response.body;

      // not modified status (304) registry does not return any payload
      // it is handled as an error
      if (response?.statusCode === HTTP_STATUS.NOT_MODIFIED) {
        throw errorUtils.getCode(HTTP_STATUS.NOT_MODIFIED, API_ERROR.NOT_MODIFIED_NO_DATA);
      }

      debug('uri %s success', uri);
      const message = "@{!status}, req: '@{request.method} @{request.url}'";
      this.logger.http(
        {
          // if error is null/false change this to undefined so it wont log
          request: { method: method, url: uri },
          status: response.statusCode,
          bytes: {
            in: options?.json ? JSON.stringify(options?.json).length : 0,
            out: responseLength || 0,
          },
        },
        message
      );
      return [data, etag];
    } catch (err: any) {
      debug('uri %s fail', uri);
      if (err.code === 'ERR_NON_2XX_3XX_RESPONSE') {
        const code = err.response.statusCode;
        if (code === HTTP_STATUS.NOT_FOUND) {
          throw errorUtils.getNotFound(errorUtils.API_ERROR.NOT_PACKAGE_UPLINK);
        }

        if (!(code >= HTTP_STATUS.OK && code < HTTP_STATUS.MULTIPLE_CHOICES)) {
          const error = errorUtils.getInternalError(
            `${errorUtils.API_ERROR.BAD_STATUS_CODE}: ${code}`
          );
          // we need this code to identify outside which status code triggered the error
          error.remoteStatus = code;
          throw error;
        }
      }
      throw err;
    }
  }

  /**
   * Get a remote package metadata
   * @param {*} name package name
   * @param {*} options request options, eg: eTag.
   * @param {*} callback
   * @deprecated do not use this method, use getRemoteMetadataNext
   */
  public getRemoteMetadata(name: string, options: any, callback: Callback): void {
    const headers = {};
    if (_.isNil(options.etag) === false) {
      headers['If-None-Match'] = options.etag;
      headers[HEADERS.ACCEPT] = contentTypeAccept;
    }

    this.request(
      {
        uri: `/${encode(name)}`,
        json: true,
        headers: headers,
        req: options.req,
      },
      (err, res, body): void => {
        if (err) {
          return callback(err);
        }
        if (res.statusCode === HTTP_STATUS.NOT_FOUND) {
          return callback(errorUtils.getNotFound(errorUtils.API_ERROR.NOT_PACKAGE_UPLINK));
        }
        if (!(res.statusCode >= HTTP_STATUS.OK && res.statusCode < HTTP_STATUS.MULTIPLE_CHOICES)) {
          const error = errorUtils.getInternalError(
            `${errorUtils.API_ERROR.BAD_STATUS_CODE}: ${res.statusCode}`
          );

          error.remoteStatus = res.statusCode;
          return callback(error);
        }
        callback(null, body, res.headers.etag);
      }
    );
  }

  public async fetchTarballNext(url: string, options: ISyncUplinksOptions): Promise<any> {
    return new Promise((resolve, reject) => {
      let current_length = 0;
      let expected_length;
      const fetchStream = new PassThrough({});
      debug('fetching url for %s', url);
      let headers = this.getHeadersNext(options?.headers);
      headers = this.addProxyHeadersNext(headers, options.remoteAddress);
      headers = this.applyUplinkHeaders(headers);
      // the following headers cannot be overwritten
      if (_.isNil(options.etag) === false) {
        headers[HEADERS.NONE_MATCH] = options.etag;
        headers[HEADERS.ACCEPT] = contentTypeAccept;
      }
      const method = 'GET';
      // const uri = this.config.url + `/${encode(name)}`;
      debug('request uri for %s', url);
      const readStream = got.stream(url, {
        headers,
        method,
        agent: this.agent,
        // FIXME: this should be taken from construtor as priority
        retry: options?.retry,
        timeout: options?.timeout,
      });

      readStream.on('request', async function () {
        try {
          await pipeline(readStream, fetchStream);
        } catch (err: any) {
          reject(err);
        }
      });

      readStream.on('response', (res) => {
        // if (response.headers.age > 3600) {
        //   console.log('Failure - response too old');
        //   readStream.destroy(); // Destroy the stream to prevent hanging resources.
        //   return;
        // }
        if (res.statusCode === HTTP_STATUS.NOT_FOUND) {
          return fetchStream.emit(
            'error',
            errorUtils.getNotFound(errorUtils.API_ERROR.NOT_FILE_UPLINK)
          );
        }

        if (!(res.statusCode >= HTTP_STATUS.OK && res.statusCode < HTTP_STATUS.MULTIPLE_CHOICES)) {
          return fetchStream.emit(
            'error',
            errorUtils.getInternalError(`bad uplink status code: ${res.statusCode}`)
          );
        }

        if (res.headers[HEADER_TYPE.CONTENT_LENGTH]) {
          expected_length = res.headers[HEADER_TYPE.CONTENT_LENGTH];
          fetchStream.emit(HEADER_TYPE.CONTENT_LENGTH, res.headers[HEADER_TYPE.CONTENT_LENGTH]);
        }
        // readStream.on('retry', {});

        // Prevent `onError` being called twice.
        // readStream.off('error', (err) => {
        //   console.log('error stream fetch', err);
        // });

        // try {
        //   // await pipeline(readStream, createWriteStream('image.png'));

        //   console.log('Success');
        //   retr
        // } catch (error) {
        //   onError(error);
        // }
      });

      resolve(fetchStream);
    });
  }

  /**
   * Fetch a tarball from the uplink.
   * @param {String} url
   * @return {Stream}
   */
  public fetchTarball(url: string) {
    const stream = new ReadTarball({});
    let current_length = 0;
    let expected_length;

    stream.abort = () => {};
    const readStream = this.request({
      uri_full: url,
      encoding: null,
      headers: {
        Accept: contentTypeAccept,
      },
    });

    readStream.on('response', function (res: any) {
      if (res.statusCode === HTTP_STATUS.NOT_FOUND) {
        return stream.emit('error', errorUtils.getNotFound(errorUtils.API_ERROR.NOT_FILE_UPLINK));
      }
      if (!(res.statusCode >= HTTP_STATUS.OK && res.statusCode < HTTP_STATUS.MULTIPLE_CHOICES)) {
        return stream.emit(
          'error',
          errorUtils.getInternalError(`bad uplink status code: ${res.statusCode}`)
        );
      }
      if (res.headers[HEADER_TYPE.CONTENT_LENGTH]) {
        expected_length = res.headers[HEADER_TYPE.CONTENT_LENGTH];
        stream.emit(HEADER_TYPE.CONTENT_LENGTH, res.headers[HEADER_TYPE.CONTENT_LENGTH]);
      }

      readStream.pipe(stream);
    });

    readStream.on('error', function (err) {
      stream.emit('error', err);
    });
    readStream.on('data', function (data) {
      current_length += data.length;
    });
    readStream.on('end', function (data) {
      if (data) {
        current_length += data.length;
      }
      if (expected_length && current_length != expected_length) {
        stream.emit('error', errorUtils.getInternalError(errorUtils.API_ERROR.CONTENT_MISMATCH));
      }
    });
    return stream;
  }

  /**
   * Perform a stream search.
   * @param {*} options request options
   * @return {Stream}
   */
  public async search({ url, abort }: ProxySearchParams): Promise<Stream.Readable> {
    debug('search url %o', url);

    let response;
    try {
      const fullURL = new URL(`${this.url}${url}`);
      // FIXME: a better way to remove duplicate slashes?
      const uri = fullURL.href.replace(/([^:]\/)\/+/g, '$1');
      this.logger.http({ uri, uplink: this.upname }, 'search request to uplink @{uplink} - @{uri}');
      response = await undiciFetch(uri, {
        method: 'GET',
        // FUTURE: whitelist domains what we are sending not need it headers, security check
        // headers: new Headers({
        //   ...headers,
        //   connection: 'keep-alive',
        // }),
        signal: abort?.signal,
      });
      debug('response.status  %o', response.status);

      if (response.status >= HTTP_STATUS.BAD_REQUEST) {
        throw errorUtils.getInternalError(`bad status code ${response.status} from uplink`);
      }

      const streamSearch = new PassThrough({ objectMode: true });
      const res = await response.text();
      const streamResponse = Readable.from(res);
      // objects is one of the properties on the body, it ignores date and total
      streamResponse.pipe(JSONStream.parse('objects')).pipe(streamSearch, { end: true });
      return streamSearch;
    } catch (err: any) {
      this.logger.error(
        { errorMessage: err?.message, name: this.upname },
        'proxy uplink @{name} search error: @{errorMessage}'
      );
      throw err;
    }
  }

  /**
   * Add proxy headers.
   * FIXME: object mutations, it should return an new object
   * @param {*} req the http request
   * @param {*} headers the request headers
   * @deprecated addProxyHeadersNext
   */
  private _addProxyHeaders(req: any, headers: any): void {
    if (req) {
      // Only submit X-Forwarded-For field if we don't have a proxy selected
      // in the config file.
      //
      // Otherwise misconfigured proxy could return 407:
      // https://github.com/rlidwka/sinopia/issues/254
      // @ts-ignore
      if (!this.agent) {
        headers[HEADERS.FORWARDED_FOR] =
          (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'] + ', ' : '') +
          req.connection.remoteAddress;
      }
    }

    // always attach Via header to avoid loops, even if we're not proxying
    headers['Via'] = req?.headers['via'] ? req.headers['via'] + ', ' : '';

    headers['Via'] += '1.1 ' + this.server_id + ' (Verdaccio)';
  }

  private addProxyHeadersNext(headers: gotHeaders, remoteAddress?: string): gotHeaders {
    // Only submit X-Forwarded-For field if we don't have a proxy selected
    // in the config file.
    //
    // Otherwise misconfigured proxy could return 407
    if (!this.agent) {
      headers[HEADERS.FORWARDED_FOR] =
        (headers['x-forwarded-for'] ? headers['x-forwarded-for'] + ', ' : '') + remoteAddress;
    }

    // always attach Via header to avoid loops, even if we're not proxying
    headers['via'] = headers['via'] ? headers['via'] + ', ' : '';
    headers['via'] += '1.1 ' + this.server_id + ' (Verdaccio)';

    return headers;
  }

  /**
   * Check whether the remote host is available.
   * @param {*} alive
   * @return {Boolean}
   * @deprecated not use
   */
  private _statusCheck(alive?: boolean): boolean | void {
    if (arguments.length === 0) {
      return this._ifRequestFailure() === false;
    }
    if (alive) {
      if (this.failed_requests >= this.max_fails) {
        this.logger.warn(
          {
            host: this.url.host,
          },
          'host @{host} is back online'
        );
      }
      this.failed_requests = 0;
    } else {
      this.failed_requests++;
      if (this.failed_requests === this.max_fails) {
        this.logger.warn(
          {
            host: this.url.host,
          },
          'host @{host} is now offline'
        );
      }
    }

    this.last_request_time = Date.now();
  }

  /**
   * If the request failure.
   * @return {boolean}
   * @private
   */
  private _ifRequestFailure(): boolean {
    return (
      this.failed_requests >= this.max_fails &&
      Math.abs(Date.now() - (this.last_request_time as number)) < this.fail_timeout
    );
  }

  /**
   * Set up a proxy.
   * @param {*} hostname
   * @param {*} config
   * @param {*} mainconfig
   * @param {*} isHTTPS
   */
  private _setupProxy(
    hostname: string,
    config: UpLinkConfLocal,
    mainconfig: Config,
    isHTTPS: boolean
  ): void {
    let noProxyList;
    const proxy_key: string = isHTTPS ? 'https_proxy' : 'http_proxy';

    // get http_proxy and no_proxy configs
    if (proxy_key in config) {
      this.proxy = config[proxy_key];
    } else if (proxy_key in mainconfig) {
      this.proxy = mainconfig[proxy_key];
    }
    if ('no_proxy' in config) {
      noProxyList = config.no_proxy;
    } else if ('no_proxy' in mainconfig) {
      noProxyList = mainconfig.no_proxy;
    }

    // use wget-like algorithm to determine if proxy shouldn't be used
    if (hostname[0] !== '.') {
      hostname = '.' + hostname;
    }

    if (_.isString(noProxyList) && noProxyList.length) {
      noProxyList = noProxyList.split(',');
    }

    if (_.isArray(noProxyList)) {
      for (let i = 0; i < noProxyList.length; i++) {
        let noProxyItem = noProxyList[i];
        if (noProxyItem[0] !== '.') {
          noProxyItem = '.' + noProxyItem;
        }
        if (hostname.lastIndexOf(noProxyItem) === hostname.length - noProxyItem.length) {
          if (this.proxy) {
            this.logger.debug(
              { url: this.url.href, rule: noProxyItem },
              'not using proxy for @{url}, excluded by @{rule} rule'
            );
            this.proxy = undefined;
          }
          break;
        }
      }
    }

    if (typeof this.proxy === 'string') {
      this.logger.debug(
        { url: this.url.href, proxy: this.proxy },
        'using proxy @{proxy} for @{url}'
      );
    }
  }
}

export { ProxyStorage };
