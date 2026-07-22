import asyncio
import base64
import aiohttp
from aiohttp import web
from winsdk.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
from winsdk.windows.storage.streams import DataReader

ELECTRON_PORT = 1488
TRIGGER_PORT = 1489
last_thumbnail = None
loop = None

async def get_thumbnail_base64():
    try:
        session_manager = await GlobalSystemMediaTransportControlsSessionManager.request_async()
        session = session_manager.get_current_session()
        if not session:
            return None

        properties = await session.try_get_media_properties_async()
        if not properties or not properties.thumbnail:
            return None

        stream_ref = properties.thumbnail
        stream = await stream_ref.open_read_async()
        if not stream or stream.size == 0:
            return None

        reader = DataReader(stream)
        size = stream.size
        await reader.load_async(size)
        buffer = bytearray(size)
        reader.read_bytes(buffer)

        b64 = base64.b64encode(bytes(buffer)).decode('utf-8')
        return f"data:image/jpeg;base64,{b64}"
    except Exception as e:
        print(f"Thumbnail fetch error: {e}")
        return None

async def send_thumbnail(thumbnail_base64):
    global last_thumbnail
    if thumbnail_base64 == last_thumbnail:
        return
    last_thumbnail = thumbnail_base64
    payload = {"thumbnail": thumbnail_base64, "title": "", "artist": "", "volume": ""}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f'http://127.0.0.1:{ELECTRON_PORT}/update',
                json=payload,
                timeout=2
            ) as resp:
                if resp.status == 200:
                    print("Thumbnail sent successfully")
    except Exception as e:
        print(f"Send error: {e}")

async def fetch_and_send():
    thumbnail = await get_thumbnail_base64()
    if thumbnail:
        await send_thumbnail(thumbnail)

async def handle_trigger(request):
    global loop
    print("Trigger received, fetching thumbnail immediately...")
    asyncio.ensure_future(fetch_and_send())
    return web.Response(text="ok")

async def periodic_check():
    while True:
        await fetch_and_send()
        await asyncio.sleep(5)

async def main():
    global loop
    loop = asyncio.get_running_loop()

    # Загружаем обложку сразу при старте, если трек уже играет
    await fetch_and_send()

    # Запускаем HTTP-сервер для триггеров
    app = web.Application()
    app.router.add_get('/fetch', handle_trigger)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', TRIGGER_PORT)
    await site.start()
    print(f"Thumbnail trigger server listening on port {TRIGGER_PORT}")

    # Периодическое обновление и сервер работают параллельно
    await periodic_check()

if __name__ == '__main__':
    asyncio.run(main())