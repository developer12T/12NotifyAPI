# FCM Notification API Test Examples

## Endpoints Available

### 1. Send Single Notification
**POST** `/api/fcm/send-notification`

**Request Body:**
```json
{
  "token": "dxYkUk-7Qh-bMNjx13qmu6:APA91bEE2xswPwfrD6MnzHxm1OyhOUOJIVDZnxzKVX_TbxhBkScR7CpDLcVKRx72GBPXCpGVVhG1nln8lEY1VEY9jNQHAxkXNX4uLac_Y6rTmTJ0KhR4kb8",
  "title": "Test Title",
  "body": "Test message body",
  "data": {
    "customKey": "customValue",
    "type": "chat_message"
  }
}
```

### 2. Send to Multiple Devices
**POST** `/api/fcm/send-to-multiple`

**Request Body:**
```json
{
  "tokens": [
    "token1",
    "token2",
    "token3"
  ],
  "title": "Group Notification",
  "body": "This is a group message",
  "data": {
    "type": "announcement"
  }
}
```

### 3. Test Notification (POST)
**POST** `/api/fcm/test-notification`

**Request Body:**
```json
{
  "token": "dxYkUk-7Qh-bMNjx13qmu6:APA91bEE2xswPwfrD6MnzHxm1OyhOUOJIVDZnxzKVX_TbxhBkScR7CpDLcVKRx72GBPXCpGVVhG1nln8lEY1VEY9jNQHAxkXNX4uLac_Y6rTmTJ0KhR4kb8"
}
```

### 4. Test Notification (GET) - Easy Testing
**GET** `/api/fcm/test-notification/dxYkUk-7Qh-bMNjx13qmu6:APA91bEE2xswPwfrD6MnzHxm1OyhOUOJIVDZnxzKVX_TbxhBkScR7CpDLcVKRx72GBPXCpGVVhG1nln8lEY1VEY9jNQHAxkXNX4uLac_Y6rTmTJ0KhR4kb8`

## Testing with cURL

### Test the GET endpoint (easiest):
```bash
curl -X GET "http://localhost:8006/api/fcm/test-notification/dxYkUk-7Qh-bMNjx13qmu6:APA91bEE2xswPwfrD6MnzHxm1OyhOUOJIVDZnxzKVX_TbxhBkScR7CpDLcVKRx72GBPXCpGVVhG1nln8lEY1VEY9jNQHAxkXNX4uLac_Y6rTmTJ0KhR4kb8"
```

### Test the POST endpoint:
```bash
curl -X POST "http://localhost:8006/api/fcm/test-notification" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "dxYkUk-7Qh-bMNjx13qmu6:APA91bEE2xswPwfrD6MnzHxm1OyhOUOJIVDZnxzKVX_TbxhBkScR7CpDLcVKRx72GBPXCpGVVhG1nln8lEY1VEY9jNQHAxkXNX4uLac_Y6rTmTJ0KhR4kb8"
  }'
```

### Send custom notification:
```bash
curl -X POST "http://localhost:8006/api/fcm/send-notification" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "dxYkUk-7Qh-bMNjx13qmu6:APA91bEE2xswPwfrD6MnzHxm1OyhOUOJIVDZnxzKVX_TbxhBkScR7CpDLcVKRx72GBPXCpGVVhG1nln8lEY1VEY9jNQHAxkXNX4uLac_Y6rTmTJ0KhR4kb8",
    "title": "Custom Notification",
    "body": "This is a custom notification message",
    "data": {
      "type": "custom",
      "timestamp": "2024-01-15T10:30:00Z"
    }
  }'
```

## Setup Requirements

1. **Install firebase-admin package:**
   ```bash
   npm install firebase-admin
   ```

2. **Firebase Service Account:**
   - Option 1: Place `serviceAccountKey.json` in the root directory
   - Option 2: Set `FIREBASE_SERVICE_ACCOUNT` environment variable with the JSON content

3. **Environment Variable Example:**
   ```bash
   export FIREBASE_SERVICE_ACCOUNT='{"type":"service_account","project_id":"your-project-id",...}'
   ```

## Expected Responses

### Success Response:
```json
{
  "success": true,
  "message": "Test notification sent successfully",
  "messageId": "projects/your-project-id/messages/123456789",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### Error Response:
```json
{
  "success": false,
  "error": "Error message here",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## Notes

- The server runs on port 8006 by default
- All endpoints are prefixed with `/api/fcm`
- The test notification includes predefined test data
- Android notifications are configured with high priority
- iOS notifications include sound and badge settings 