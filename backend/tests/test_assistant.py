from datetime import datetime, timedelta
import uuid

import httpx
from sqlalchemy import func, select

from backend.database import bookings
from backend.schemas import SearchCriteria
from backend.search import IST, answer_travel_question, interpret
from .test_api import app, book, login, remaining


def booking_count(application):
    with application.state.engine.connect() as conn:
        return conn.execute(select(func.count()).select_from(bookings)).scalar_one()


def test_assistant_answers_bus_questions_without_changing_bookings(app):
    application, client = app
    before = booking_count(application)
    cases = {
        'How do I cancel my ticket?': 'confirm',
        'Can I pay by UPI or get a refund?': 'no payment',
        'Where can I travel?': 'Available cities',
        'How do I download my ticket?': 'PDF',
    }
    for query, phrase in cases.items():
        response = client.post('/api/assistant/answer', json={'query': query})
        assert response.status_code == 200, response.text
        assert response.json()['mode'] == 'offline'
        assert phrase.lower() in response.json()['answer'].lower()
    assert booking_count(application) == before
    assert client.post('/api/assistant/answer', json={'query': 'x'}).status_code == 422
    assert client.post('/api/assistant/answer', json={'query': 'x' * 501}).status_code == 422
    too_much_history = [{'role': 'user', 'content': 'hello'}] * 9
    assert client.post('/api/assistant/answer', json={
        'query': 'What about that?', 'history': too_much_history}).status_code == 422


def test_responses_adapter_is_private_concise_and_has_offline_fallback(monkeypatch):
    monkeypatch.delenv('GROQ_API_KEY', raising=False)
    monkeypatch.setenv('OPENAI_API_KEY', 'test-key-not-real')
    captured = {}

    def fake_post(self, url, **kwargs):
        captured.update(kwargs['json'])
        assert url == 'https://api.openai.com/v1/responses'
        assert kwargs['headers']['Authorization'] == 'Bearer test-key-not-real'
        return httpx.Response(200, request=httpx.Request('POST', url), json={
            'output': [{'type': 'message', 'content': [
                {'type': 'output_text', 'text': 'Please arrive 15 minutes before departure.'}
            ]}]
        })

    monkeypatch.setattr(httpx.Client, 'post', fake_post)
    history = [
        {'role': 'user', 'content': 'I am travelling overnight.'},
        {'role': 'assistant', 'content': 'I can help with overnight bus travel.'},
    ]
    answer, mode = answer_travel_question('When should I arrive?',
                                          ['Hyderabad', 'Bangalore'], history)
    assert mode == 'ai' and '15 minutes' in answer
    assert captured['store'] is False
    assert captured['max_output_tokens'] == 180
    assert 'name, age, phone' in captured['instructions']
    assert 'Never say you lack live schedule data, cannot book' in captured['instructions']
    assert captured['input'] == history + [
        {'role': 'user', 'content': 'When should I arrive?'}]

    def fail(self, url, **kwargs):
        raise httpx.TimeoutException('provider unavailable')

    monkeypatch.setattr(httpx.Client, 'post', fail)
    answer, mode = answer_travel_question('Can I download a PDF?', ['Hyderabad'])
    assert mode == 'offline' and 'PDF' in answer


def test_groq_is_preferred_for_search_and_travel_answers(monkeypatch):
    monkeypatch.setenv('GROQ_API_KEY', 'groq-test-key-not-real')
    monkeypatch.setenv('GROQ_MODEL', 'openai/gpt-oss-20b')
    monkeypatch.setenv('OPENAI_API_KEY', 'openai-fallback-not-used')
    tomorrow = (datetime.now(IST) + timedelta(days=1)).date().isoformat()
    criteria = SearchCriteria(origin='Hyderabad', destination='Bangalore',
                              travel_date=tomorrow, preferred_type='AC')
    calls = []

    def fake_post(self, url, **kwargs):
        calls.append((url, kwargs))
        assert kwargs['headers']['Authorization'] == 'Bearer groq-test-key-not-real'
        assert kwargs['json']['model'] == 'openai/gpt-oss-20b'
        if url.endswith('/chat/completions'):
            schema = kwargs['json']['response_format']['json_schema']['schema']
            assert schema['additionalProperties'] is False
            return httpx.Response(200, request=httpx.Request('POST', url), json={
                'choices': [{'message': {'content': criteria.model_dump_json()}}]
            })
        return httpx.Response(200, request=httpx.Request('POST', url), json={
            'output': [{'type': 'message', 'content': [
                {'type': 'output_text', 'text': 'Carry your ticket and arrive early.'}
            ]}]
        })

    monkeypatch.setattr(httpx.Client, 'post', fake_post)
    parsed, mode, _ = interpret('Hyderabad to Bangalore tomorrow, preferably AC',
                                ['Hyderabad', 'Bangalore'])
    assert mode == 'ai' and parsed.preferred_type == 'AC'
    answer, mode = answer_travel_question('What should I carry?', ['Hyderabad'])
    assert mode == 'ai' and 'ticket' in answer
    assert [call[0] for call in calls] == [
        'https://api.groq.com/openai/v1/chat/completions',
        'https://api.groq.com/openai/v1/responses',
    ]


def test_assistant_tool_flow_searches_books_lists_and_cancels_for_owner(app):
    application, client = app
    tomorrow = (datetime.now(IST) + timedelta(days=1)).date().isoformat()
    result = client.post('/api/search/natural', json={
        'query': f'Hyderabad to Bangalore on {tomorrow}'
    })
    assert result.status_code == 200, result.text
    trip = result.json()['trips'][0]

    login(client)
    before = remaining(application, trip['id'])
    ticket = book(client, trip, str(uuid.uuid4()))
    assert ticket.status_code == 201, ticket.text
    ticket = ticket.json()
    assert remaining(application, trip['id']) == before - 1
    mine = client.get('/api/bookings').json()
    assert any(row['id'] == ticket['id'] for row in mine)

    login(client, 'priya')
    assert client.post(f"/api/bookings/{ticket['id']}/cancel").status_code == 404
    login(client)
    cancelled = client.post(f"/api/bookings/{ticket['id']}/cancel")
    assert cancelled.status_code == 200 and cancelled.json()['status'] == 'Cancelled'
    assert remaining(application, trip['id']) == before
