// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
'use strict';

import {
  JSONObject, deepEqual
} from 'phosphor/lib/algorithm/json';

import {
  IDisposable, DisposableDelegate
} from 'phosphor/lib/core/disposable';

import {
  ISignal, clearSignalData, defineSignal
} from 'phosphor/lib/core/signaling';

import {
  KernelFutureHandler
} from './kernel/future';

import {
  IKernel, Kernel, KernelMessage
} from './kernel';

import * as utils
  from './utils';

/**
 * The default kernel spec models.
 */
export
const KERNELSPECS: Kernel.ISpecModels = {
  default: 'python',
  kernelspecs: {
    python: {
      name: 'python',
      spec: {
        language: 'python',
        argv: [],
        display_name: 'Python',
        env: {}
      },
      resources: {}
    },
    shell: {
      name: 'shell',
      spec: {
        language: 'shell',
        argv: [],
        display_name: 'Shell',
        env: {}
      },
      resources: {}
    }
  }
};


/**
 * The code input to trigger an error.
 */
export
const ERROR_INPUT = 'trigger execute error';


/**
 * The default language infos.
 */
const LANGUAGE_INFOS: { [key: string]: KernelMessage.ILanguageInfo } = {
  python: {
    name: 'python',
    version: '1',
    mimetype: 'text/x-python',
    file_extension: '.py',
    pygments_lexer: 'python',
    codemirror_mode: 'python',
    nbconverter_exporter: ''
  },
  shell: {
    name: 'shell',
    version: '1',
    mimetype: 'text/x-sh',
    file_extension: '.sh',
    pygments_lexer: 'shell',
    codemirror_mode: 'shell',
    nbconverter_exporter: ''
  }
};


/**
 * A mock kernel object.
 */
export
class MockKernel implements IKernel {

  id: string;
  name: string;
  username = '';
  clientId = '';

  /**
   * Construct a new mock kernel.
   */
  constructor(options: Kernel.IModel = {}) {
    this.id = options.id || utils.uuid();
    this.name = options.name || 'python';
    let name = this.name;
    if (!(name in KERNELSPECS.kernelspecs)) {
      name = 'python';
    }
    this._kernelspec = KERNELSPECS.kernelspecs[name].spec;
    this._kernelInfo = {
      protocol_version: '1',
      implementation: 'foo',
      implementation_version: '1',
      language_info: LANGUAGE_INFOS[name],
      banner: 'Hello',
      help_links: {}
    };
    Promise.resolve().then(() => {
      this._changeStatus('idle');
    });
    Private.runningKernels[this.id] = this;
  }

  /**
   * A signal emitted when the kernel status changes.
   */
  statusChanged: ISignal<IKernel, Kernel.Status>;

  /**
   * A signal emitted for iopub kernel messages.
   */
  iopubMessage: ISignal<IKernel, KernelMessage.IIOPubMessage>;

  /**
   * A signal emitted for unhandled kernel message.
   */
  unhandledMessage: ISignal<IKernel, KernelMessage.IMessage>;

  /**
   * The current status of the kernel.
   */
  get status(): Kernel.Status {
    return this._status;
  }

  /**
   * The model associated with the kernel.
   *
   * #### Notes
   * This is a read-only property.
   */
  get model(): Kernel.IModel {
    return { name: this.name, id: this.id };
  }

  get info(): KernelMessage.IInfoReply {
    return this._kernelInfo;
  }

  get spec(): Kernel.ISpec {
    return this._kernelspec;
  }

  /**
   * Test whether the kernel has been disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Dispose of the resources held by the kernel.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._futures = null;
    delete Private.runningKernels[this.id];
  }

  /**
   * Send a shell message to the kernel.
   */
  sendShellMessage(msg: KernelMessage.IShellMessage, expectReply=false, disposeOnDone=true): Kernel.IFuture {
    let future = new KernelFutureHandler(() => {
      let index = this._futures.indexOf(future);
      if (index !== -1) {
        this._futures.splice(index, 1);
      }
    }, msg, expectReply, disposeOnDone);
    this._futures.push(future);
    return future;
  }

  /**
   * Send a message to the kernel.
   */
  sendServerMessage(msgType: string, channel: KernelMessage.Channel, content: JSONObject, future: Kernel.IFuture): void {
    if (future.isDisposed) {
      return;
    }
    let options: KernelMessage.IOptions = {
      msgType,
      channel,
      username: this.username,
      session: this.clientId
    };
    let msg = KernelMessage.createMessage(options, content);
    if (msgType === 'status') {
      let statusMsg = msg as KernelMessage.IStatusMsg;
      this._changeStatus(statusMsg.content.execution_state);
    }
    (future as KernelFutureHandler).handleMsg(msg);
  }

  /**
   * Send a shell reply message to the kernel.
   */
  sendShellReply(content: JSONObject): void {
    if (this.isDisposed) {
      return;
    }
    let future = this._futures.shift();
    if (!future) {
      return;
    }
    let msgType = future.msg.header.msg_type.replace('_request', '_reply');
    this.sendServerMessage(msgType, 'shell', content, future);
  }

  /**
   * Interrupt a kernel.
   */
  interrupt(): Promise<void> {
    this._changeStatus('busy');
    return Promise.resolve().then(() => {
      this._changeStatus('idle');
    });
  }

  /**
   * Restart a kernel.
   */
  restart(): Promise<void> {
    this._changeStatus('restarting');
    return Promise.resolve().then(() => {
      this._changeStatus('idle');
    });
  }


  /**
   * Reconnect to a disconnected kernel. This is not actually a
   * standard HTTP request, but useful function nonetheless for
   * reconnecting to the kernel if the connection is somehow lost.
   */
  reconnect(): Promise<void> {
    this._changeStatus('reconnecting');
    return Promise.resolve().then(() => {
      this._changeStatus('idle');
    });
  }

  /**
   * Shutdown a kernel.
   */
  shutdown(): Promise<void> {
    this._changeStatus('dead');
    this.dispose();
    return Promise.resolve(void 0);
  }

  /**
   * Get the kernel info.
   */
  kernelInfo(): Promise<KernelMessage.IInfoReplyMsg> {
    let options: KernelMessage.IOptions = {
      msgType: 'kernel_info_reply',
      channel: 'shell',
      username: '',
      session: ''
    };
    let msg = KernelMessage.createMessage(options, this._kernelInfo);
    return Promise.resolve(msg);
  }

  /**
   * Send a `complete_request` message.
   */
  complete(content: KernelMessage.ICompleteRequest): Promise<KernelMessage.ICompleteReplyMsg> {
    return this._sendKernelMessage('complete_request', 'shell', content);
  }

  /**
   * Send a `history_request` message.
   */
  history(content: KernelMessage.IHistoryRequest): Promise<KernelMessage.IHistoryReplyMsg> {
    return this._sendKernelMessage('history_request', 'shell', content);
  }


  /**
   * Send an `inspect_request` message.
   */
  inspect(content: KernelMessage.IInspectRequest): Promise<KernelMessage.IInspectReplyMsg> {
    return this._sendKernelMessage('inspect_request', 'shell', content);
  }

  /**
   * Send an `execute_request` message.
   *
   * #### Notes
   * This simulates an actual exection on the server.
   * Use `ERROR_INPUT` to simulate an input error.
   */
  execute(content: KernelMessage.IExecuteRequest, disposeOnDone: boolean = true): Kernel.IFuture {
    let options: KernelMessage.IOptions = {
      msgType: 'execute_request',
      channel: 'shell',
      username: '',
      session: ''
    };
    let defaults = {
      silent : false,
      store_history : true,
      user_expressions : {},
      allow_stdin : true,
      stop_on_error : false
    };
    content = utils.extend(defaults, content);
    let msg = KernelMessage.createMessage(options, content) as KernelMessage.IShellMessage;
    let future = this.sendShellMessage(msg, true, disposeOnDone);
    let count = ++this._executionCount;

    // Delay sending the message so the handlers can be set up.
    setTimeout(() => {
      if (this.isDisposed || future.isDisposed) {
        return;
      }
      // Send a typical stream of messages.
      this.sendServerMessage('status', 'iopub', {
        execution_state: 'busy'
      }, future);
      this.sendServerMessage('stream', 'iopub', {
        name: 'stdout',
        text: 'foo'
      }, future);
      this.sendServerMessage('status', 'iopub', {
        execution_state: 'idle'
      }, future);
      // Handle an explicit error.
      if (content.code === ERROR_INPUT) {
        this.sendShellReply({
          execution_count: count,
          status: 'error',
          ename: 'mock',
          evalue: ERROR_INPUT,
          traceback: []
        });
        // Cancel remaining executes if necessary.
        if (content.stop_on_error) {
          this._handleStop();
        }
      } else {
        this.sendShellReply({
          execution_count: count,
          status: 'ok',
          user_expressions: {},
          payload: {}
        });
      }
    }, 0);
    return future;
  }

  /**
   * Send an `is_complete_request` message.
   */
  isComplete(content: KernelMessage.IIsCompleteRequest): Promise<KernelMessage.IIsCompleteReplyMsg> {
    return this._sendKernelMessage('is_complete_request', 'shell', content);
  }

  /**
   * Send a `comm_info_request` message.
   */
  commInfo(content: KernelMessage.ICommInfoRequest): Promise<KernelMessage.ICommInfoReplyMsg> {
    return this._sendKernelMessage('comm_info_request', 'shell', content);
  }

  /**
   * Send an `input_reply` message.
   */
  sendInputReply(content: KernelMessage.IInputReply): void { }

  /**
   * Register a comm target handler.
   */
  registerCommTarget(targetName: string, callback: (comm: Kernel.IComm, msg: KernelMessage.ICommOpenMsg) => void): IDisposable {
    return void 0;
  }

  /**
   * Connect to a comm, or create a new one.
   */
  connectToComm(targetName: string, commId?: string): Kernel.IComm {
    return void 0;
  }

  /**
   * Get the kernel spec associated with the kernel.
   */
  getSpec(): Promise<Kernel.ISpec> {
    return Promise.resolve(this._kernelspec);
  }

  /**
   * Register a message hook
   */
  registerMessageHook(msg_id: string, hook: (msg: KernelMessage.IIOPubMessage) => boolean): IDisposable {
    return new DisposableDelegate(() => {});
  }

  /**
   * Send a messaage to the mock kernel.
   */
  private _sendKernelMessage(msgType: string, channel: KernelMessage.Channel, content: JSONObject): Promise<KernelMessage.IShellMessage> {
    let options: KernelMessage.IOptions = {
      msgType,
      channel,
      username: this.username,
      session: this.clientId
    };
    let msg = KernelMessage.createMessage(options, content) as KernelMessage.IShellMessage;
    let future: Kernel.IFuture;
    try {
      future = this.sendShellMessage(msg, true);
    } catch (e) {
      return Promise.reject(e);
    }
    return new Promise<KernelMessage.IShellMessage>((resolve, reject) => {
      future.onReply = (reply: KernelMessage.IShellMessage) => {
        resolve(reply);
      };
    });
  }

  /**
   * Handle a `stop_on_error` error event.
   */
  private _handleStop(): void {
    // Trigger immediate errors on remaining execute messages.
    let futures = this._futures.slice();
    for (let future of futures) {
      if (future.msg.header.msg_type === 'execute_request') {
        this.sendServerMessage('status', 'iopub', {
          execution_state: 'idle'
        }, future);
        this.sendShellReply({
          execution_count: null,
          status: 'error',
          ename: 'mock',
          evalue: ERROR_INPUT,
          traceback: []
        });
      }
    }
  }

  /**
   * Change the status of the mock kernel.
   */
  private _changeStatus(status: Kernel.Status): void {
    if (this._status === status) {
      return;
    }
    this._status = status;
    this.statusChanged.emit(status);
  }

  private _status: Kernel.Status = 'unknown';
  private _isDisposed = false;
  private _futures: KernelFutureHandler[] = [];
  private _kernelspec: Kernel.ISpec = null;
  private _kernelInfo: KernelMessage.IInfoReply = null;
  private _executionCount = 0;
}


/**
 * A mock kernel manager object.
 */
export
class MockKernelManager implements Kernel.IManager {

  /**
   * A signal emitted when the specs change.
   */
  specsChanged: ISignal<Kernel.IManager, Kernel.ISpecModels>;

  /**
   * A signal emitted when the running kernels change.
   */
  runningChanged: ISignal<Kernel.IManager, Kernel.IModel[]>;

  /**
   * Test whether the terminal manager is disposed.
   *
   * #### Notes
   * This is a read-only property.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Dispose of the resources used by the manager.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._isDisposed = true;
    clearSignalData(this);
    this._specs = null;
    this._running = [];
  }

  getSpecs(options?: Kernel.IOptions): Promise<Kernel.ISpecModels> {
    return Promise.resolve(KERNELSPECS);
  }

  listRunning(options?: Kernel.IOptions): Promise<Kernel.IModel[]> {
    let models: Kernel.IModel[] = [];
    for (let id in Private.runningKernels) {
      let kernel = Private.runningKernels[id];
      models.push({ name: kernel.name, id });
    }
    if (!deepEqual(models, this._running)) {
      this._running = models.slice();
      this.runningChanged.emit(models);
    }
    return Promise.resolve(models);
  }

  startNew(options?: Kernel.IOptions, id?: string): Promise<MockKernel> {
    let name = options ? options.name : void 0;
    return Promise.resolve(new MockKernel({ name, id }));
  }

  findById(id: string, options?: Kernel.IOptions): Promise<Kernel.IModel> {
    if (id in Private.runningKernels) {
      return Promise.resolve(Private.runningKernels[id].model);
    }
    return Promise.resolve(void 0);
  }

  connectTo(id: string, options?: Kernel.IOptions): Promise<MockKernel> {
    if (id in Private.runningKernels) {
      return Promise.resolve(Private.runningKernels[id]);
    }
    return this.startNew(options, id);
  }

  shutdown(id: string, options?: Kernel.IOptions): Promise<void> {
    let kernel = Private.runningKernels[id];
    if (!kernel) {
      return Promise.reject(`No running kernel with id: ${id}`);
    }
    return kernel.shutdown();
  }

  private _running: Kernel.IModel[] = [];
  private _specs: Kernel.ISpecModels = null;
  private _isDisposed = false;
}


// Define the signals for the `MockKernel` class.
defineSignal(MockKernel.prototype, 'statusChanged');
defineSignal(MockKernel.prototype, 'iopubMessage');
defineSignal(MockKernel.prototype, 'unhandledMessage');


// Define the signal for the `MockKernelKernelManager` class.
defineSignal(MockKernelManager.prototype, 'specsChanged');
defineSignal(MockKernelManager.prototype, 'runningChanged');



namespace Private {
  /**
   * A module private store for running mock kernels.
   */
  export
  const runningKernels: { [key: string]: MockKernel; } = Object.create(null);
}
