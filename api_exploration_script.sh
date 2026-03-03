#!/bin/bash
# datasync-explore.sh
# Replace with your actual API key
API_KEY="YOUR_API_KEY_HERE"
BASE="http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com/api/v1"

echo "========================================="
echo "1. API Root - discover endpoints"
echo "========================================="
curl -si "$BASE" \
  -H "X-API-Key: $API_KEY" | tee /tmp/root.json
echo -e "\n"

echo "========================================="
echo "2. GET /events - default (no params)"
echo "========================================="
curl -si "$BASE/events" \
  -H "X-API-Key: $API_KEY" | tee /tmp/events_default.json
echo -e "\n"

echo "========================================="
echo "3. GET /events - try common pagination params"
echo "========================================="
curl -si "$BASE/events?limit=100&page=1" \
  -H "X-API-Key: $API_KEY" | tee /tmp/events_page.json
echo -e "\n"

echo "========================================="
echo "4. GET /events - try cursor-based pagination"
echo "========================================="
curl -si "$BASE/events?limit=100" \
  -H "X-API-Key: $API_KEY" | tee /tmp/events_cursor.json
echo -e "\n"

echo "========================================="
echo "5. GET /events - try offset param"
echo "========================================="
curl -si "$BASE/events?limit=1000&offset=0" \
  -H "X-API-Key: $API_KEY" | tee /tmp/events_offset.json
echo -e "\n"

echo "========================================="
echo "6. GET /sessions"
echo "========================================="
curl -si "$BASE/sessions" \
  -H "X-API-Key: $API_KEY" | tee /tmp/sessions.json
echo -e "\n"

echo "========================================="
echo "7. GET /metrics"
echo "========================================="
curl -si "$BASE/metrics" \
  -H "X-API-Key: $API_KEY" | tee /tmp/metrics.json
echo -e "\n"

echo "========================================="
echo "8. GET /submissions - check existing"
echo "========================================="
curl -si "$BASE/submissions" \
  -H "X-API-Key: $API_KEY" | tee /tmp/submissions.json
echo -e "\n"

echo "========================================="
echo "9. OPTIONS preflight - sniff allowed methods"
echo "========================================="
curl -si -X OPTIONS "$BASE/events" \
  -H "X-API-Key: $API_KEY"
echo -e "\n"

echo "========================================="
echo "10. HEAD /events - check response headers only"
echo "========================================="
curl -si -I "$BASE/events" \
  -H "X-API-Key: $API_KEY"
echo -e "\n"

echo "========================================="
echo "11. Try bulk/batch endpoint (undocumented)"
echo "========================================="
curl -si "$BASE/events/bulk" \
  -H "X-API-Key: $API_KEY"
curl -si "$BASE/events?bulk=true&limit=10000" \
  -H "X-API-Key: $API_KEY"
echo -e "\n"

echo "========================================="
echo "12. Extract cursor from first response and paginate"
echo "========================================="
CURSOR=$(cat /tmp/events_cursor.json | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    # try common cursor field names
    for key in ['cursor', 'next_cursor', 'nextCursor', 'pagination', 'meta']:
        if key in data:
            print(data[key])
            break
except: pass
" 2>/dev/null)

if [ -n "$CURSOR" ]; then
  echo "Found cursor: $CURSOR"
  curl -si "$BASE/events?cursor=$CURSOR&limit=100" \
    -H "X-API-Key: $API_KEY"
fi

echo "========================================="
echo "Done! Review /tmp/*.json for results"
echo "========================================="
