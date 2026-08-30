"""
LLM Creative Layer — Layer 2 (disconnected, optional).

This layer is COMPLETELY DISCONNECTED from Layer 1 (deterministic).
It can be:
  - Enabled: bots get LLM-powered creativity for complex reasoning
  - Disabled: simulation runs purely on deterministic personalities
  - Swapped: any LLM API can be plugged in (Cohere, OpenAI, local)

The simulation ALWAYS works without this layer.
When enabled, it adds creative intelligence on top of deterministic behavior.

Architecture:
  Layer 1 (deterministic) → BotPersonality → generate_prompt()
  Layer 2 (LLM creative) → LLMBotEnhancer → enhance_prompt()

The enhancer takes the deterministic prompt and optionally rewrites it
to be more creative/realistic using an LLM. But if the LLM is unavailable,
it falls back to the deterministic prompt unchanged.

Connection points for LLM APIs:
  - Cohere (command-a) via REST API
  - OpenAI via REST API
  - Local LLM via HTTP
  - Any OpenAI-compatible endpoint
"""
import asyncio
import json
import os
import random
import aiohttp
from typing import Optional, Protocol
from dataclasses import dataclass


class LLMProvider(Protocol):
    """Interface for any LLM provider. Swap freely."""
    
    async def generate(
        self,
        prompt: str,
        system: str = "",
        temperature: float = 0.7,
        max_tokens: int = 500,
    ) -> str:
        """Generate text from the LLM."""
        ...


class CohereProvider:
    """Cohere Command A — the existing COMPaNiON LLM."""
    
    def __init__(self, api_key: str, model: str = "command-a-03-2025"):
        self.api_key = api_key
        self.model = model
        self.endpoint = "https://api.cohere.com/v2/chat"
    
    async def generate(
        self,
        prompt: str,
        system: str = "",
        temperature: float = 0.7,
        max_tokens: int = 500,
    ) -> str:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        body = {
            "model": self.model,
            "messages": [
                {"role": "SYSTEM", "content": system or "You are a creative user testing a SaaS platform."},
                {"role": "USER", "content": prompt},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        
        async with aiohttp.ClientSession() as session:
            async with session.post(self.endpoint, json=body, headers=headers) as resp:
                data = await resp.json()
                # Cohere v2 response format
                if "content" in data:
                    return data["content"][0]["text"]
                return str(data)


class OpenAIProvider:
    """OpenAI-compatible endpoint — works with OpenAI, local LLMs, etc."""
    
    def __init__(self, api_key: str, model: str = "gpt-4o-mini", endpoint: str = "https://api.openai.com/v1"):
        self.api_key = api_key
        self.model = model
        self.endpoint = endpoint
    
    async def generate(
        self,
        prompt: str,
        system: str = "",
        temperature: float = 0.7,
        max_tokens: int = 500,
    ) -> str:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system or "You are a creative user testing a SaaS platform."},
                {"role": "user", "content": prompt},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.endpoint}/chat/completions", json=body, headers=headers
            ) as resp:
                data = await resp.json()
                return data["choices"][0]["message"]["content"]


class LocalLLMProvider:
    """Local LLM via LM Studio, Ollama, etc. Free, sovereign."""
    
    def __init__(self, endpoint: str = "http://localhost:1234/v1", model: str = "local"):
        self.endpoint = endpoint
        self.model = model
    
    async def generate(
        self,
        prompt: str,
        system: str = "",
        temperature: float = 0.7,
        max_tokens: int = 500,
    ) -> str:
        # Uses OpenAI-compatible API
        return await OpenAIProvider(
            api_key="local", model=self.model, endpoint=self.endpoint
        ).generate(prompt, system, temperature, max_tokens)


@dataclass
class LLMBotEnhancer:
    """
    Enhances deterministic bots with LLM creativity.
    
    DISCONNECTED from Layer 1 — if this fails, the simulation
    continues with deterministic prompts unchanged.
    """
    provider: Optional[LLMProvider] = None
    enabled: bool = False
    enhancement_rate: float = 0.1  # 10% of prompts get LLM enhancement
    fallback_on_error: bool = True  # Always fallback to deterministic
    
    async def enhance_prompt(
        self,
        deterministic_prompt: str,
        bot_personality: dict,
        turn: int,
        rng: random.Random,
    ) -> str:
        """Optionally enhance a deterministic prompt with LLM creativity.
        
        If LLM is unavailable or enhancement_rate not hit, returns the
        original deterministic prompt unchanged.
        """
        if not self.enabled or not self.provider:
            return deterministic_prompt
        
        # Only enhance a fraction of prompts (saves API costs)
        if rng.random() > self.enhancement_rate:
            return deterministic_prompt
        
        try:
            system_prompt = f"""You are role-playing as a real user testing a SaaS app-building platform.
User personality: {json.dumps(bot_personality, indent=2)}

Rewrite this prompt to sound more natural and human-like, as if this person 
would actually type it. Keep it short (1-3 sentences). Don't add new requirements,
just make it sound like a real person typing quickly:

Original: {deterministic_prompt}

Respond with ONLY the rewritten prompt, no explanation:"""
            
            enhanced = await asyncio.wait_for(
                self.provider.generate(
                    prompt=deterministic_prompt,
                    system=system_prompt,
                    temperature=0.8,
                    max_tokens=100,
                ),
                timeout=5.0,
            )
            
            # Clean up — remove quotes, newlines
            enhanced = enhanced.strip().strip('"').strip("'")
            return enhanced if enhanced else deterministic_prompt
            
        except Exception as e:
            if self.fallback_on_error:
                return deterministic_prompt
            raise
    
    async def enhance_evaluation(
        self,
        response: dict,
        bot_personality: dict,
        deterministic_satisfaction: float,
        rng: random.Random,
    ) -> float:
        """Optionally use LLM to evaluate response quality more nuancedly.
        
        Falls back to deterministic satisfaction if LLM unavailable.
        """
        if not self.enabled or not self.provider:
            return deterministic_satisfaction
        
        if rng.random() > self.enhancement_rate:
            return deterministic_satisfaction
        
        try:
            system_prompt = f"""You are evaluating a SaaS platform response from a user's perspective.
User personality: {json.dumps(bot_personality, indent=2)}

Response: {json.dumps(response, indent=2)[:500]}

Rate satisfaction from 0.0 to 1.0 (one decimal). Respond with ONLY the number:"""
            
            result = await asyncio.wait_for(
                self.provider.generate(
                    prompt=str(response)[:500],
                    system=system_prompt,
                    temperature=0.3,
                    max_tokens=10,
                ),
                timeout=5.0,
            )
            
            score = float(result.strip())
            return max(0.0, min(1.0, score))
            
        except Exception:
            return deterministic_satisfaction


def create_llm_layer(
    provider_type: str = "cohere",
    api_key: str = "",
    model: str = "",
    endpoint: str = "",
) -> LLMBotEnhancer:
    """
    Create an LLM enhancement layer.
    
    Args:
        provider_type: "cohere", "openai", "local", or "none"
        api_key: API key for the provider
        model: Model name
        endpoint: Custom endpoint (for local LLMs)
    
    Returns:
        LLMBotEnhancer — disabled by default. Call .enabled = True to activate.
    """
    if provider_type == "none" or not api_key:
        return LLMBotEnhancer(provider=None, enabled=False)
    
    if provider_type == "cohere":
        provider = CohereProvider(api_key, model or "command-a-03-2025")
    elif provider_type == "openai":
        provider = OpenAIProvider(api_key, model or "gpt-4o-mini", endpoint or "https://api.openai.com/v1")
    elif provider_type == "local":
        provider = LocalLLMProvider(endpoint or "http://localhost:1234/v1", model or "local")
    else:
        return LLMBotEnhancer(provider=None, enabled=False)
    
    return LLMBotEnhancer(provider=provider, enabled=True)


if __name__ == "__main__":
    print("LLM Creative Layer — Disconnected from deterministic simulation")
    print()
    print("Providers:")
    print("  - Cohere (command-a-03-2025)")
    print("  - OpenAI (gpt-4o-mini or compatible)")
    print("  - Local (LM Studio, Ollama — free, sovereign)")
    print()
    print("Usage:")
    print("  enhancer = create_llm_layer('cohere', api_key=os.environ.get('COHERE_API_KEY'))")
    print("  enhancer.enabled = True  # Turn on")
    print("  enhanced = await enhancer.enhance_prompt('make a todo app', personality, 0, rng)")
    print()
    print("If disabled or LLM fails → deterministic prompt returned unchanged.")
    print("The simulation ALWAYS works without this layer.")
