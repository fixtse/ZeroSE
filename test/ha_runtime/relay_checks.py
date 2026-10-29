"""Exercise the real aiohttp relay, including bytes, revocation and OAuth redirect."""
import importlib
from types import SimpleNamespace
from unittest.mock import patch
from aiohttp import web, ClientSession
from aiohttp.test_utils import TestServer
from homeassistant.components.http import KEY_HASS


async def verify_relay(hass):
    relay = importlib.import_module('custom_components.assistant_zero.relay')
    posts = []
    offers = []
    revoked = False
    async def control(request):
        assert request.headers['Authorization'] == 'Bearer integration-test-only'
        if revoked:
            return web.Response(status=401)
        if request.method == 'POST':
            offers.append(await request.json())
            return web.json_response({'configured': True})
        return web.json_response({'adminUrl': 'http://zero-admin.example'})
    async def receive(request):
        posts.append((request.path, await request.read(), dict(request.headers)))
        return web.Response(status=202, body=b'private-provider-body', headers={'Set-Cookie': 'private-cookie'})
    upstream = web.Application()
    upstream.router.add_route('*', '/v1/integrations/home-assistant/relay', control)
    upstream.router.add_post('/telegram/assistants/zero/webhook', receive)
    upstream.router.add_post('/v1/triggers/rule-events', receive)
    async with TestServer(upstream) as server:
        entry = SimpleNamespace(entry_id='relay-test', data={'url': str(server.make_url('')).rstrip('/'), 'settings_token': 'integration-test-only'})
        with patch.object(relay, 'get_url', return_value='https://ha.example'):
            await relay.async_setup_relay(hass, entry)
        assert offers == [{'url': 'https://ha.example/api/assistant_zero/relay/relay-test'}]
        app = web.Application()
        app[KEY_HASS] = hass
        view = relay.ZeroRelayView()
        async def route(request):
            handler = view.get if request.method == 'GET' else view.post
            return await handler(request, request.match_info['entry_id'], request.match_info['path'])
        app.router.add_route('*', view.url, route)
        async with TestServer(app) as public, ClientSession() as client:
            prefix = '/api/assistant_zero/relay/relay-test'
            async def post(path, **kwargs):
                return await client.post(public.make_url(prefix + path), **kwargs)
            response = await post('/telegram/assistants/zero/webhook', data=b'{"update_id":1}', headers={'X-Telegram-Bot-Api-Secret-Token': 'telegram-secret', 'Cookie': 'admin=private'})
            assert response.status == 202
            assert await response.read() == b'' and 'Set-Cookie' not in response.headers
            assert posts[0][1] == b'{"update_id":1}'
            assert posts[0][2]['X-Telegram-Bot-Api-Secret-Token'] == 'telegram-secret'
            assert 'Cookie' not in posts[0][2] and 'Authorization' not in posts[0][2]
            assert (await post('/v1/admin/setup/tokens')).status == 404
            assert (await post('/telegram/assistants/zero/webhook')).status == 401
            assert (await post('/telegram/assistants/zero/webhook', data=b'x' * 1000001, headers={'X-Telegram-Bot-Api-Secret-Token': 'secret'})).status == 413
            assert len(posts) == 1
            response = await client.get(public.make_url(prefix + '/v1/admin/google/oauth/callback?state=test-state&code=test-code&evil=drop'), allow_redirects=False)
            assert response.status == 303
            assert response.headers['Location'] == 'http://zero-admin.example/v1/admin/google/oauth/callback?state=test-state&code=test-code'
            assert response.headers['Referrer-Policy'] == 'no-referrer'
            revoked = True
            assert (await post('/telegram/assistants/zero/webhook', data=b'{}', headers={'X-Telegram-Bot-Api-Secret-Token': 'secret'})).status == 503
            assert len(posts) == 1
            assert (await client.get(public.make_url(prefix + '/v1/admin/google/oauth/callback?state=x'), allow_redirects=False)).status == 503
            relay.async_unload_relay(hass, entry)
            assert (await post('/telegram/assistants/zero/webhook')).status == 404
