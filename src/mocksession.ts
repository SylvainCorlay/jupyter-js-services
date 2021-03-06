// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  deepEqual
} from 'phosphor/lib/algorithm/json';

import {
  ISignal, clearSignalData, defineSignal
} from 'phosphor/lib/core/signaling';

import {
  ISession, Session
} from './session';

import {
  IKernel, KernelMessage, Kernel
} from './kernel';

import {
  KERNELSPECS, MockKernel
} from './mockkernel';

import {
  IAjaxSettings, uuid
} from './utils';


/**
 * A mock session object that uses a mock kernel by default.
 */
export
class MockSession implements ISession {

  id: string;
  path: string;
  ajaxSettings: IAjaxSettings = {};

  constructor(model?: Session.IModel) {
    if (!model) {
      model = {
        id: uuid(),
        notebook: {
          path: ''
        },
        kernel: {}
      };
    }
    this.id = model.id;
    this.path = model.notebook.path;
    this._kernel = new MockKernel(model.kernel);
    this._kernel.statusChanged.connect(this.onKernelStatus, this);
    this._kernel.unhandledMessage.connect(this.onUnhandledMessage, this);
    Private.runningSessions[this.id] = this;
  }

  /**
   * A signal emitted when the session dies.
   */
  sessionDied: ISignal<MockSession, void>;

  /**
   * A signal emitted when the kernel changes.
   */
  kernelChanged: ISignal<MockSession, MockKernel>;

  /**
   * A signal emitted when the kernel status changes.
   */
  statusChanged: ISignal<MockSession, Kernel.Status>;

  /**
   * A signal emitted for a kernel messages.
   */
  iopubMessage: ISignal<MockSession, KernelMessage.IIOPubMessage>;

  /**
   * A signal emitted for an unhandled kernel message.
   */
  unhandledMessage: ISignal<MockSession, KernelMessage.IMessage>;

  /**
   * A signal emitted when the session path changes.
   */
  pathChanged: ISignal<MockSession, string>;

  /**
   * Get the session kernel object.
   */
  get kernel(): MockKernel {
    return this._kernel;
  }

  /**
   * Get the session model.
   */
  get model(): Session.IModel {
    return {
      id: this.id,
      kernel: this.kernel.model,
      notebook: {
        path: this.path
      }
    };
  }

  /**
   * The current status of the session.
   */
  get status(): Kernel.Status {
    return this._kernel.status;
  }

  /**
   * Test whether the session has been disposed.
   *
   * #### Notes
   * This is a read-only property which is always safe to access.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Dispose of the resources held by the session.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._isDisposed = true;
    delete Private.runningSessions[this.id];
  }

  /**
   * Rename or move the session.
   */
  rename(path: string): Promise<void> {
    this.path = path;
    return Promise.resolve(void 0);
  }

  /**
   * Change the kernel.
   */
  changeKernel(options: Kernel.IModel): Promise<MockKernel> {
    this._kernel.dispose();
    this._kernel = new MockKernel(options);
    this.kernelChanged.emit(this._kernel);
    return Promise.resolve(this._kernel);
  }

  /**
   * Kill the kernel and shutdown the session.
   */
  shutdown(): Promise<void> {
    this._kernel.dispose();
    this._kernel = null;
    this.sessionDied.emit(void 0);
    return Promise.resolve(void 0);
  }

  /**
   * Handle to changes in the Kernel status.
   */
  protected onKernelStatus(sender: IKernel, state: Kernel.Status) {
    this.statusChanged.emit(state);
  }

  /**
   * Handle unhandled kernel messages.
   */
  protected onUnhandledMessage(sender: IKernel, msg: KernelMessage.IMessage) {
    this.unhandledMessage.emit(msg);
  }

  private _isDisposed = false;
  private _kernel: MockKernel = null;
}


/**
 *  A mock session manager object.
 */
export
class MockSessionManager implements Session.IManager {
  /**
   * A signal emitted when the kernel specs change.
   */
  specsChanged: ISignal<MockSessionManager, Kernel.ISpecModels>;

  /**
   * A signal emitted when the running sessions change.
   */
  runningChanged: ISignal<MockSessionManager, Session.IModel[]>;

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
    this._running = [];
  }

  /**
   * Get the available kernel specs.
   */
  getSpecs(options?: Session.IOptions): Promise<Kernel.ISpecModels> {
    return Promise.resolve(KERNELSPECS);
  }

  /*
   * Get the running sessions.
   */
  listRunning(options?: Session.IOptions): Promise<Session.IModel[]> {
    let models: Session.IModel[] = [];
    for (let id in Private.runningSessions) {
      let session = Private.runningSessions[id];
      models.push(session.model);
    }
    if (!deepEqual(models, this._running)) {
      this._running = models.slice();
      this.runningChanged.emit(models);
    }
    return Promise.resolve(models);
  }

  /**
   * Start a new session.
   */
  startNew(options: Session.IOptions, id?: string): Promise<MockSession> {
    let session = new MockSession({
      id,
      notebook: {
        path: options.path || ''
      },
      kernel: {
        id: options.kernelId,
        name: options.kernelName
      }
    });
    return Promise.resolve(session);
  }

  /**
   * Find a session by id.
   */
  findById(id: string, options?: Session.IOptions): Promise<Session.IModel> {
    if (id in Private.runningSessions) {
      return Promise.resolve(Private.runningSessions[id].model);
    }
    return Promise.resolve(void 0);
  }

  /**
   * Find a session by path.
   */
  findByPath(path: string, options?: Session.IOptions): Promise<Session.IModel> {
    for (let id in Private.runningSessions) {
      let session = Private.runningSessions[id];
      if (session.path === path) {
        return Promise.resolve(session.model);
      }
    }
    return Promise.resolve(void 0);
  }

  /**
   * Connect to a running session.
   */
  connectTo(id: string, options?: Session.IOptions): Promise<MockSession> {
    if (id in Private.runningSessions) {
      return Promise.resolve(Private.runningSessions[id]);
    }
    return this.startNew(options, id);
  }

  shutdown(id: string, options?: Kernel.IOptions): Promise<void> {
    let session = Private.runningSessions[id];
    if (!session) {
      return Promise.reject(`No running sessions with id: ${id}`);
    }
    return session.shutdown();
  }

  private _isDisposed = false;
  private _running: Session.IModel[] = [];
}


// Define the signals for the `MockSession` class.
defineSignal(MockSession.prototype, 'sessionDied');
defineSignal(MockSession.prototype, 'kernelChanged');
defineSignal(MockSession.prototype, 'statusChanged');
defineSignal(MockSession.prototype, 'iopubMessage');
defineSignal(MockSession.prototype, 'unhandledMessage');
defineSignal(MockSession.prototype, 'pathChanged');


// Define the signals for the `MockSessionManager` class.
defineSignal(MockSessionManager.prototype, 'specsChanged');
defineSignal(MockSessionManager.prototype, 'runningChanged');


/**
 * A namespace for notebook session private data.
 */
namespace Private {
  /**
   * A module private store for running mock sessions.
   */
  export
  const runningSessions: { [key: string]: MockSession; } = Object.create(null);
}
