async def _validate_voice_request(update: Update) -> tuple[Any | None, str | None]:
    """Validate auth, rate limit, voice attachment, size, and daily quota."""
    user_id, reason = _check_auth_and_throttle(update)
    if user_id is None:
        return None, reason or "Unauthorized."

    voice = _get_voice(update)
    if voice is None:
        return None, "❌ 無法取得語音檔案"
    if voice.file_size and voice.file_size > MAX_VOICE_BYTES:
        return None, "Voice file too large."
    if not await check_daily_quota(user_id):
        return None, "今日額度已用完，請明天再試。"

    return voice, None


async def _edit_or_ignore(msg: Any, text: str) -> None:
    """Safely edit a status message if it exists."""
    if msg:
        try:
            await msg.edit_text(text)
        except Exception:
            logger.debug("Failed to edit status message", exc_info=True)


async def handle_voice(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    voice, error_msg = await _validate_voice_request(update)
    if error_msg or voice is None:
        await _reply(update, error_msg or "❌ 無法取得語音檔案")
        return

    msg = await _reply(update, "⏳ Transcribing...")
    try:
        text = await _download_and_transcribe(voice)
    except Exception:
        logger.exception("Whisper failed")
        await _edit_or_ignore(msg, "❌ 語音轉錄失敗，請稍後再試。")
        return

    if not text or not text.strip():
        await _edit_or_ignore(msg, "⚠️ 無法辨識語音內容，請重新錄製。")
        return

    await _enqueue_voice_task(update, context, msg, text)
