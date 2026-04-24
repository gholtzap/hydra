"""
Hydra Voice Agent - Pipecat bot with SmallWebRTC transport and MCP tools.
"""

import argparse
import asyncio
import os
from contextlib import asynccontextmanager

import uvicorn
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import IceServer, SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.turns.user_mute import (
    FunctionCallUserMuteStrategy,
    MuteUntilFirstBotCompleteUserMuteStrategy,
)


SYSTEM_PROMPT = """\
You are a voice assistant for Hydra, a developer workspace application.
You can control Hydra using the available tools: create sessions, send input
to agents, manage workspaces, search sessions, read files, manage settings,
and operate the wiki.

Guidelines:
- Keep responses concise and conversational. Your output is spoken aloud.
- Avoid emojis, bullet points, markdown, or formatting that cannot be spoken.
- When performing actions, briefly confirm what you did.
- If a tool call fails, explain the error simply and suggest alternatives.
"""


pcs_map: dict[str, SmallWebRTCConnection] = {}
ice_servers = [IceServer(urls="stun:stun.l.google.com:19302")]


def create_stt(provider: str):
    if provider == "deepgram":
        from pipecat.services.deepgram.stt import DeepgramSTTService

        return DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"])

    if provider == "google":
        from pipecat.services.google.stt import GoogleSTTService

        return GoogleSTTService(api_key=os.environ["GOOGLE_API_KEY"])

    if provider == "whisper":
        from pipecat.services.whisper.stt import WhisperSTTService

        return WhisperSTTService(
            settings=WhisperSTTService.Settings(
                model=os.environ.get("WHISPER_MODEL", "base"),
            )
        )

    raise ValueError(f"Unknown STT provider: {provider}")


def create_llm(provider: str):
    if provider == "openai":
        from pipecat.services.openai.llm import OpenAILLMService

        return OpenAILLMService(
            api_key=os.environ["OPENAI_API_KEY"],
            settings=OpenAILLMService.Settings(system_instruction=SYSTEM_PROMPT),
        )

    if provider == "anthropic":
        from pipecat.services.anthropic.llm import AnthropicLLMService

        return AnthropicLLMService(
            api_key=os.environ["ANTHROPIC_API_KEY"],
            settings=AnthropicLLMService.Settings(system_instruction=SYSTEM_PROMPT),
        )

    if provider == "google":
        from pipecat.services.google.llm import GoogleLLMService

        return GoogleLLMService(
            api_key=os.environ["GOOGLE_API_KEY"],
            settings=GoogleLLMService.Settings(system_instruction=SYSTEM_PROMPT),
        )

    if provider == "ollama":
        from pipecat.services.openai.llm import OpenAILLMService

        return OpenAILLMService(
            api_key="ollama",
            base_url="http://localhost:11434/v1",
            settings=OpenAILLMService.Settings(
                model=os.environ.get("OLLAMA_MODEL", "llama3.1"),
                system_instruction=SYSTEM_PROMPT,
            ),
        )

    raise ValueError(f"Unknown LLM provider: {provider}")


def create_tts(provider: str, voice: str | None = None):
    if provider == "cartesia":
        from pipecat.services.cartesia.tts import CartesiaTTSService

        return CartesiaTTSService(
            api_key=os.environ["CARTESIA_API_KEY"],
            settings=CartesiaTTSService.Settings(
                voice=voice or "71a7ad14-091c-4e8e-a314-022ece01c121",
            ),
        )

    if provider == "elevenlabs":
        from pipecat.services.elevenlabs.tts import ElevenLabsTTSService

        return ElevenLabsTTSService(
            api_key=os.environ["ELEVENLABS_API_KEY"],
            settings=ElevenLabsTTSService.Settings(
                voice=voice or "21m00Tcm4TlvDq8ikWAM",
            ),
        )

    if provider == "deepgram":
        from pipecat.services.deepgram.tts import DeepgramTTSService

        return DeepgramTTSService(
            api_key=os.environ["DEEPGRAM_API_KEY"],
            settings=DeepgramTTSService.Settings(voice=voice or "aura-asteria-en"),
        )

    raise ValueError(f"Unknown TTS provider: {provider}")


async def run_bot(webrtc_connection: SmallWebRTCConnection, args: argparse.Namespace):
    logger.info("Starting Hydra voice bot")

    transport = SmallWebRTCTransport(
        webrtc_connection=webrtc_connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )

    stt = create_stt(args.stt_provider)
    llm = create_llm(args.llm_provider)
    tts = create_tts(args.tts_provider, args.tts_voice)

    mcp_client = None
    tools = None
    if args.mcp_url:
        try:
            from mcp.client.session_group import StreamableHttpParameters
            from pipecat.services.mcp_service import MCPClient

            mcp_client = MCPClient(
                server_params=StreamableHttpParameters(url=args.mcp_url),
            )
            await mcp_client.start()
            tools = await mcp_client.register_tools(llm)
            logger.info(f"Registered {len(tools.standard_tools)} MCP tools from Hydra")
        except Exception as exc:
            logger.warning(f"Failed to connect to Hydra MCP server: {exc}")
            logger.warning("Voice agent will run without tool access")

    context = LLMContext(tools=tools)
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(),
            user_mute_strategies=[
                MuteUntilFirstBotCompleteUserMuteStrategy(),
                FunctionCallUserMuteStrategy(),
            ],
        ),
    )

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            llm,
            tts,
            transport.output(),
            assistant_aggregator,
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
    )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected")
        context.add_message(
            {
                "role": "developer",
                "content": "Greet the user briefly and say you can help control Hydra by voice. Keep it to one sentence.",
            }
        )
        await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected")
        await task.cancel()

    runner = PipelineRunner(handle_sigint=False)

    try:
        await runner.run(task)
    finally:
        if mcp_client:
            await mcp_client.close()


def create_app(args: argparse.Namespace) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logger.info(f"Hydra voice bot ready on port {args.port}")
        print("HYDRA_VOICE_READY", flush=True)
        yield
        await asyncio.gather(*[pc.disconnect() for pc in pcs_map.values()])
        pcs_map.clear()

    app = FastAPI(lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "sessions": len(pcs_map),
            "llm": args.llm_provider,
            "stt": args.stt_provider,
            "tts": args.tts_provider,
        }

    @app.post("/api/offer")
    async def offer(request: dict, background_tasks: BackgroundTasks):
        pc_id = request.get("pc_id")

        if pc_id and pc_id in pcs_map:
            pipecat_connection = pcs_map[pc_id]
            await pipecat_connection.renegotiate(
                sdp=request["sdp"],
                type=request["type"],
                restart_pc=request.get("restart_pc", False),
            )
        else:
            pipecat_connection = SmallWebRTCConnection(ice_servers)
            await pipecat_connection.initialize(sdp=request["sdp"], type=request["type"])

            @pipecat_connection.event_handler("closed")
            async def handle_disconnected(webrtc_connection: SmallWebRTCConnection):
                pcs_map.pop(webrtc_connection.pc_id, None)

            background_tasks.add_task(run_bot, pipecat_connection, args)

        answer = pipecat_connection.get_answer()
        pcs_map[answer["pc_id"]] = pipecat_connection
        return answer

    @app.patch("/api/offer")
    async def ice_candidate(request: dict):
        pipecat_connection = pcs_map.get(request.get("pc_id"))
        if not pipecat_connection:
            raise HTTPException(status_code=404, detail="Peer connection not found")

        try:
            from aiortc.sdp import candidate_from_sdp

            for payload in request.get("candidates", []):
                candidate = candidate_from_sdp(payload["candidate"])
                candidate.sdpMid = payload.get("sdp_mid")
                candidate.sdpMLineIndex = payload.get("sdp_mline_index")
                await pipecat_connection.add_ice_candidate(candidate)
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Invalid ICE candidate") from exc

        return {"status": "ok"}

    @app.post("/api/config")
    async def update_config(payload: dict):
        for key, attr in {
            "llmProvider": "llm_provider",
            "sttProvider": "stt_provider",
            "ttsProvider": "tts_provider",
            "ttsVoice": "tts_voice",
            "enableSubagents": "enable_subagents",
        }.items():
            if key in payload:
                setattr(args, attr, payload[key])

        return {
            "llmProvider": args.llm_provider,
            "sttProvider": args.stt_provider,
            "ttsProvider": args.tts_provider,
            "ttsVoice": args.tts_voice,
            "enableSubagents": args.enable_subagents,
        }

    return app


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Hydra Voice Bot")
    parser.add_argument("--port", type=int, default=7860)
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--mcp-url", default="http://127.0.0.1:4141/mcp")
    parser.add_argument("--llm-provider", default="openai")
    parser.add_argument("--stt-provider", default="deepgram")
    parser.add_argument("--tts-provider", default="cartesia")
    parser.add_argument("--tts-voice", default=None)
    parser.add_argument("--enable-subagents", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    parsed_args = parse_args()
    if parsed_args.enable_subagents:
        logger.warning("Subagent mode is configured but handoff wiring is not active yet.")
    uvicorn.run(create_app(parsed_args), host=parsed_args.host, port=parsed_args.port)
