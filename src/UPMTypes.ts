import type { UtilityProcess } from "electron"
import { isDefined, isFunction, isString } from "@3fv/guard"
import { Deferred } from "@3fv/deferred"
import Tracer from "tracer"

const log = Tracer.colorConsole()

export namespace UPM {
  
  export const Defaults = { RequestTimeout: 120000 }
  
  export enum MessageKind {
    Event = "Event",
    Request = "Request",
    Response = "Response"
  }
  
  export enum IPCChannel {
    UPMServiceMessage = "UPMServiceMessage",
    UPMServiceNewClient = "UPMServiceNewClient"
  }
  
  export enum NodeMessageType {
    UPMNodeEventMessage = "UPMNodeEventMessage",
    UPMNodeRequestResponse = "UPMNodeRequestResponseMessage",
  }
  
  export type MessageArgs = {}
  // export type MessageRequestMap = {}
  
  export type MessageArgNames<Args extends MessageArgs> = keyof Args
  export type MessageArgData<Args extends MessageArgs, Name extends MessageArgNames<Args>> = Args[Name]
  // export type MessageRequestNames<Args extends MessageRequestMap> = keyof Args
  // export type MessageRequestParams<Args extends MessageRequestMap, Name extends MessageArgNames<Args>> = Args[Name]
  export interface Message<
    Args extends MessageArgs = any,
    Type extends MessageArgNames<Args> = MessageArgNames<Args>
  >
  {
    type: Type;
    kind: MessageKind;
    messageId: number;
    data: MessageArgData<Args, Type>;
    error?: string
  }
  
  export interface NodeEnvelope<Payload extends {} = any> {
    channel: IPCChannel
    payload: Payload
  }
  
  export type RequestHandler<
    Args extends MessageArgs = any,
    Type extends MessageArgNames<Args> = MessageArgNames<Args>,
    R = any
  > = (type: Type, messageId: number, data: Args[Type]) => Promise<R>
  
  
  export type NodeMessage<
    Args extends MessageArgs = any,
    Type extends MessageArgNames<Args> = MessageArgNames<Args>> = NodeEnvelope<Message<Args, Type>>
  
  export interface PendingRequestMessage<
    Args extends UPM.MessageArgs = any,
    Type extends UPM.MessageArgNames<Args> = UPM.MessageArgNames<Args>,
    R = any
  >
  {
    deferred: Deferred<R>
    
    timeoutId: ReturnType<typeof setTimeout>
    
    messageId: number
  }
  
  /**
   * @returns true if payload was handled, false if not
   */
  export type EventHandler = (clientId: string, port: UPM.Port, payload: any) => boolean
  
  export function isMessagePort(port: UPM.Port): port is Electron.MessagePortMain {
    return isFunction(port?.["close"])
  }
  
  export function isUtilityProcess(port: UPM.Port): port is UtilityProcess {
    return !!port && !isMessagePort(port)
  }
  
  export type Port = MessagePort | Electron.MessagePortMain | Electron.ParentPort | UtilityProcess
  
  export interface IServiceClient<
    Args extends MessageArgs,
    MType extends MessageArgNames<Args> = UPM.MessageArgNames<Args>
  >
  {
    sendEvent(data: any): void
    
    executeRequest<Type extends MType, R = any>(
      type: Type,
      data: MessageArgData<Args, Type>
    ): Promise<R>
    
    close(): void
    
    whenReady(): Promise<IServiceClient<Args, MType>>
  }
  
  //
  export class PortServiceClient<
    Args extends MessageArgs,
    MType extends MessageArgNames<Args> = UPM.MessageArgNames<Args>
  > implements IServiceClient<Args, MType> {
    
    private lastMessageId_: number = 0
    
    private pendingMessages_ = new Map<number, PendingRequestMessage>()
    
    private generateMessageId(): number {
      return this.lastMessageId_++
    }
    
    private removePendingMessage(messageId: number): void {
      const pending = this.pendingMessages_.get(messageId)
      if (!pending) {
        return
      }
      clearTimeout(pending.timeoutId)
      if (!pending.deferred.isSettled()) {
        pending.deferred.reject("The pending message is being removed before promise is settled")
      }
      this.pendingMessages_.delete(messageId)
    }
    
    private onMessage<Type extends MType = any>(payloadOrEnvelopeOrData: any): void {
      const
        payloadOrEnvelope = (isDefined(payloadOrEnvelopeOrData?.["data"]) ?
          payloadOrEnvelopeOrData["data"] :
          payloadOrEnvelopeOrData) as UPM.Message<Args, Type> | UPM.NodeMessage<Args, Type>,
        [channel, payload] =
          (isDefined(payloadOrEnvelope?.["payload"]) ?
          [payloadOrEnvelope["channel"] ?? IPCChannel.UPMServiceMessage, payloadOrEnvelope["payload"]] :
          [IPCChannel.UPMServiceMessage, payloadOrEnvelope]) as [string, UPM.Message<Args, Type>],
        { type, kind, messageId, data, error } = payload
      
      try {
        const pending = this.pendingMessages_.get(messageId)
        if (!pending) {
          log.info(`Unable to find pending record ${messageId}`)
          return
        }
        
        if (pending.deferred.isSettled()) {
          log.error(`Already settled record ${messageId}`)
          return
        }
        
        if (!!error) {
          log.error(error)
          pending.deferred.reject(new Error(error))
          return
        }
        pending.deferred.resolve(data)
        this.removePendingMessage(messageId)
      } catch (err) {
        log.error(`Failed to handle message`, err)
      }
    }
    
    
    sendEvent(data: any): void {
      const messageId = this.generateMessageId()
      const payload: UPM.NodeEnvelope = {
        channel: UPM.IPCChannel.UPMServiceMessage,
        payload: { messageId, data, kind: UPM.MessageKind.Event }
      }
      
      this.port.postMessage(payload)
    }
    
    async executeRequest<Type extends MType, R = any>(
      type: Type,
      data: MessageArgData<Args, Type>,
      timeout: number = Defaults.RequestTimeout
    ): Promise<R> {
      const messageId = this.generateMessageId(),
        pending: UPM.PendingRequestMessage<Args, Type, R> = {
          deferred: new Deferred<R>(),
          messageId,
          timeoutId: setTimeout(() => this.removePendingMessage(messageId), timeout)
        }
      
      this.pendingMessages_.set(messageId, pending)
      const payload: UPM.NodeMessage<Args, Type> = {
        channel: UPM.IPCChannel.UPMServiceMessage,
        payload: { type, messageId, data, kind: UPM.MessageKind.Request }
      }
      
      this.port.postMessage(payload)
      
      try {
        const result = await pending.deferred.promise
        log.debug(`Completed utility request (messageId=${messageId})`)
        return result
      } catch (err) {
        log.error(`Failed utility request (messageId=${messageId})`, err)
        throw err
      }
    }
    
    close(): void {
    }
    
    whenReady(): Promise<this> {
      return Promise.resolve(this)
    }
    
    constructor(readonly clientId: string, readonly port: UPM.Port) {
      if (isMessagePort(port) || isUtilityProcess(port)) {
        port.on("message", this.onMessage.bind(this))
        if (isMessagePort(port))
          port.start()
      } else {
        log.error("Invalid port", port)
        throw new Error("Invalid port")
      }
      
    }
  }
}