import {
  runAgentLoopContinue,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type StreamFn,
} from '@earendil-works/pi-agent-core'
import { EventStream } from '@earendil-works/pi-ai'

/** Forward preparation failures as well as events from the Pi loop. */
export async function* continueAgentLoop(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): AsyncGenerator<AgentEvent> {
  const events = new EventStream<AgentEvent, AgentMessage[]>(
    event => event.type === 'agent_end',
    event => event.type === 'agent_end' ? event.messages : [],
  )
  let failure: { error: unknown } | undefined
  // pi-agent-core's event-stream convenience API does not handle rejection
  // from convertToLlm. Own the producer promise so compression errors cannot
  // leave the consumer waiting forever on an open stream.
  void runAgentLoopContinue(context, config, event => { events.push(event) }, signal, streamFn)
    .then(messages => events.end(messages), error => {
      failure = { error }
      events.end([])
    })
  for await (const event of events) yield event
  if (failure) throw failure.error
}
