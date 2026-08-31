# pi-siliconflow

Расширение-провайдер SiliconFlow для pi coding agent.

## Установка

```bash
pi install ~/pi-plugins/pi-siliconflow
```

## Авторизация

Два способа:

1. **Интерактивный логин** (ключ сохраняется в `~/.pi/agent/auth.json`):
   - в сессии pi выполните `/login siliconflow` и вставьте ключ;
   - поле ввода — секретное, со ссылкой на https://cloud.siliconflow.cn/account/ak

2. **Переменная окружения**:
   ```bash
   export SILICONFLOW_API_KEY=sk-...
   ```

Приоритет: сохранённый ключ (`auth.json`) → переменная окружения.
Выход: `/logout siliconflow`.

## Модели

- `siliconflow/deepseek-ai/DeepSeek-V4-Flash` (reasoning, контекст 256K)

Выбор модели: `/model` внутри pi или `pi --model siliconflow/deepseek-ai/DeepSeek-V4-Flash`.
