"""Verify Zero's AI Task protocol against the pinned real HA service schema."""
import asyncio
import json
from pathlib import Path
import tempfile

from homeassistant.bootstrap import async_setup_hass
from homeassistant.runner import RuntimeConfig
from homeassistant.setup import async_setup_component
from homeassistant.components.ai_task import AITaskEntity, GenDataTaskResult
from homeassistant.components.ai_task.const import AITaskEntityFeature, DATA_COMPONENT, DATA_PREFERENCES


async def main():
    with tempfile.TemporaryDirectory(prefix="zero-ai-task-check-") as directory:
        Path(directory, "configuration.yaml").write_text("homeassistant:\n  name: AI provider validation\n  latitude: 0\n  longitude: 0\n  elevation: 0\n  unit_system: metric\n  time_zone: UTC\n  currency: EUR\n  country: ES\n")
        hass = await async_setup_hass(RuntimeConfig(config_dir=directory))
        assert hass is not None
        try:
            assert await async_setup_component(hass, "ai_task", {})
            calls = []

            class TestAI(AITaskEntity):
                _attr_name = "Zero provider test"
                _attr_unique_id = "zero-provider-test"
                _attr_supported_features = AITaskEntityFeature.GENERATE_DATA
                _attr_should_poll = False

                async def _async_generate_data(self, task, chat_log):
                    calls.append(task)
                    assert task.llm_api is None, "HA must not execute tools on Zero's behalf"
                    assert task.instructions.startswith("Zero policy")
                    return GenDataTaskResult(conversation_id="zero-test-task", data={"result": json.dumps({"action": "final", "text": "HA model response"})})

            entity = TestAI()
            await hass.data[DATA_COMPONENT].async_add_entities([entity])
            await hass.async_block_till_done()
            assert hass.states.get(entity.entity_id).state == "unknown", "Unused AI Task entities have no last activity yet"
            payload = {
                "task_name": "Zero assistant response",
                "entity_id": entity.entity_id,
                "instructions": "Zero policy\nRequest data: question",
                "structure": {"result": {"description": "Next Zero response protocol object encoded as JSON.", "required": True, "selector": {"text": {}}}},
            }
            result = await hass.services.async_call("ai_task", "generate_data", payload, blocking=True, return_response=True)
            assert json.loads(result["data"]["result"]) == {"action": "final", "text": "HA model response"}
            assert result["conversation_id"] == "zero-test-task"
            hass.data[DATA_PREFERENCES].async_set_preferences(gen_data_entity_id=entity.entity_id)
            preferred = await hass.services.async_call("ai_task", "generate_data", {k: v for k, v in payload.items() if k != "entity_id"}, blocking=True, return_response=True)
            assert preferred["data"] == result["data"]
            assert len(calls) == 2
            assert not hass.config_entries.async_entries("assistant_zero"), "Inference must not create or replace a Zero integration"
            print("Real Home Assistant AI Task: configured entity, preferred entity, structured response protocol, and no HA tool delegation passed")
        finally:
            await hass.async_stop(force=True)


asyncio.run(main())
