import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import database
from planner import BUDGET_CATEGORIES, build_plan, chatbot_reply
from werkzeug.security import check_password_hash, generate_password_hash


def authenticated_client(client, email="owner@example.com"):
    user_id = database.create_user(email, generate_password_hash("correct-horse-battery"))
    csrf_token = "test-csrf-token"
    with client.session_transaction() as stored_session:
        stored_session["user_id"] = user_id
        stored_session["csrf_token"] = csrf_token
    client.environ_base["HTTP_X_CSRF_TOKEN"] = csrf_token
    return client


class EventPlanGenerationTests(unittest.TestCase):
    def setUp(self):
        self.details = {
            "event_type": "College Event",
            "event_date": "2032-05-18",
            "location": "Mysuru",
            "guests": 180,
            "budget": 240000,
            "theme": "Sustainable campus festival",
            "food": "Vegan and locally sourced",
        }

    def test_plan_sections_use_submitted_event_details(self):
        plan = build_plan(self.details)

        self.assertIn("college event", plan["overview"].lower())
        self.assertIn("Mysuru", plan["overview"])
        self.assertIn("180 guests", plan["overview"])
        self.assertIn("Sustainable campus festival", plan["overview"])
        self.assertIn("Vegan and locally sourced", plan["food_suggestions"][0])
        self.assertIn("Mysuru", plan["venue_suggestions"][0])
        self.assertIn("Sustainable campus festival", plan["decoration_suggestions"][0])
        self.assertTrue(plan["photography_suggestions"])
        self.assertTrue(plan["entertainment_suggestions"])
        self.assertTrue(plan["schedule"])
        self.assertTrue(plan["checklist"])

        total_expenses = sum(plan["allocation"].values()) + plan["remaining_budget"]
        self.assertAlmostEqual(total_expenses, plan["budget"], places=2)

    def test_guidance_changes_with_event_type(self):
        wedding = build_plan({
            **self.details,
            "event_type": "Wedding",
            "theme": "Garden ceremony",
        })

        self.assertIn("ceremony", wedding["photography_suggestions"][0].lower())
        self.assertIn("first dance", wedding["entertainment_suggestions"][0].lower())
        self.assertNotEqual(wedding["checklist"], build_plan(self.details)["checklist"])

    def test_new_sections_survive_save_and_legacy_plan_retrieval(self):
        plan = build_plan(self.details)
        legacy_plan = dict(plan)
        for field in ("overview", "photography_suggestions", "entertainment_suggestions", "checklist_items"):
            del legacy_plan[field]

        with TemporaryDirectory() as directory:
            with patch.object(database, "DB_PATH", Path(directory) / "plans.db"):
                database.init_db()
                user_id = database.create_user("legacy@example.com", generate_password_hash("correct-horse-battery"))
                plan_id, created = database.create_plan(legacy_plan, user_id)
                saved = database.get_plan(plan_id, user_id)

        self.assertTrue(created)
        self.assertEqual(saved["overview"], plan["overview"])
        self.assertEqual(saved["photography_suggestions"], plan["photography_suggestions"])
        self.assertEqual(saved["entertainment_suggestions"], plan["entertainment_suggestions"])
        self.assertEqual(saved["checklist_items"], plan["checklist_items"])

    def test_api_saves_and_retrieves_complete_plan_without_duplicates(self):
        with TemporaryDirectory() as directory:
            with patch.object(database, "DB_PATH", Path(directory) / "plans.db"):
                database.init_db()
                from app import app

                with app.test_client() as raw_client:
                    client = authenticated_client(raw_client)
                    first = client.post("/api/plans", json=self.details)
                    second = client.post("/api/plans", json=self.details)
                    saved_plans = client.get("/api/plans")

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 200)
        self.assertFalse(first.get_json()["already_saved"])
        self.assertTrue(second.get_json()["already_saved"])
        self.assertTrue(first.get_json()["photography_suggestions"])
        self.assertTrue(first.get_json()["entertainment_suggestions"])
        self.assertEqual(len(saved_plans.get_json()), 1)

    def test_plan_preview_preserves_entered_budget_and_date(self):
        from app import app

        details = {**self.details, "budget": 40000, "event_date": "2027-12-15"}
        with app.test_client() as client:
            csrf_token = client.get("/api/auth/csrf").get_json()["csrf_token"]
            client.environ_base["HTTP_X_CSRF_TOKEN"] = csrf_token
            response = client.post("/api/plan-preview", json=details)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["budget"], 40000)
        self.assertEqual(response.get_json()["event_date"], "2027-12-15")

    def test_chatbot_budget_answer_is_friendly_and_uses_the_exact_amount(self):
        reply = chatbot_reply(
            "Show my budget breakdown",
            {**self.details, "budget": 40000},
        )

        self.assertIn("₹40,000 total", reply)
        self.assertNotIn("₹4,00,000", reply)
        self.assertIn("\n- Venue:", reply)
        self.assertIn("Left for unexpected costs:", reply)

    def test_chatbot_food_answer_is_clear_without_repeating_the_menu(self):
        reply = chatbot_reply("How should I plan the food?")

        self.assertIn("a menu that suits your guests", reply)
        self.assertIn("per-person prices", reply)
        self.assertNotIn("guests menu", reply)

    def test_chatbot_responds_to_greetings_and_small_talk_naturally(self):
        greeting = chatbot_reply("Hi")
        how_are_you = chatbot_reply("How are you?")
        planning_question = chatbot_reply("How are you planning the food?")

        self.assertIn("Hi!", greeting)
        self.assertIn("I’m doing well, thanks for asking", how_are_you)
        self.assertIn("menu", planning_question.lower())
        self.assertNotIn("doing well", planning_question.lower())

    def test_api_supports_complete_plan_crud_without_creating_duplicates(self):
        edited_details = {
            **self.details,
            "event_date": "2033-06-20",
            "location": "Bengaluru",
            "guests": 240,
            "budget": 360000,
            "theme": "Modern innovation summit",
            "food": "Vegetarian buffet",
        }

        with TemporaryDirectory() as directory:
            with patch.object(database, "DB_PATH", Path(directory) / "plans.db"):
                database.init_db()
                from app import app

                with app.test_client() as raw_client:
                    client = authenticated_client(raw_client)
                    created = client.post("/api/plans", json=self.details)
                    plan_id = created.get_json()["id"]
                    listed = client.get("/api/plans")
                    viewed = client.get(f"/api/plans/{plan_id}")
                    edited = client.put(f"/api/plans/{plan_id}", json=edited_details)
                    retrieved_after_edit = client.get(f"/api/plans/{plan_id}")
                    duplicate = client.post("/api/plans", json=edited_details)
                    deleted = client.delete(f"/api/plans/{plan_id}")
                    missing_after_delete = client.get(f"/api/plans/{plan_id}")
                    empty_after_delete = client.get("/api/plans")

        self.assertEqual(created.status_code, 201)
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(len(listed.get_json()), 1)
        self.assertEqual(viewed.status_code, 200)
        self.assertEqual(viewed.get_json()["title"], build_plan(self.details)["title"])
        self.assertEqual(edited.status_code, 200)
        updated_plan = retrieved_after_edit.get_json()
        for field in ("event_date", "location", "guests", "budget", "theme", "food"):
            self.assertEqual(updated_plan[field], edited_details[field])
        self.assertEqual(duplicate.status_code, 200)
        self.assertEqual(duplicate.get_json()["id"], plan_id)
        self.assertTrue(duplicate.get_json()["already_saved"])
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(missing_after_delete.status_code, 404)
        self.assertEqual(empty_after_delete.get_json(), [])

    def test_budget_allocations_include_all_categories_and_reserve_contingency(self):
        plan = build_plan(self.details)

        self.assertEqual(set(plan["allocation"]), set(BUDGET_CATEGORIES))
        self.assertAlmostEqual(
            sum(plan["allocation"].values()) + plan["remaining_budget"],
            plan["budget"],
            places=2,
        )
        self.assertAlmostEqual(plan["remaining_budget"], plan["budget"] * 0.05, places=2)

    def test_budget_edits_are_validated_and_persisted(self):
        with TemporaryDirectory() as directory:
            with patch.object(database, "DB_PATH", Path(directory) / "plans.db"):
                database.init_db()
                from app import app

                with app.test_client() as raw_client:
                    client = authenticated_client(raw_client)
                    created = client.post("/api/plans", json=self.details)
                    plan_id = created.get_json()["id"]
                    allocation = {category: 1000 for category in BUDGET_CATEGORIES}
                    updated = client.put(
                        f"/api/plans/{plan_id}/budget",
                        json={"allocation": allocation},
                    )
                    retrieved = client.get(f"/api/plans/{plan_id}")
                    over_budget = client.put(
                        f"/api/plans/{plan_id}/budget",
                        json={"allocation": {category: 40000 for category in BUDGET_CATEGORIES}},
                    )
                    excessive_precision = client.put(
                        f"/api/plans/{plan_id}/budget",
                        json={"allocation": {**allocation, "Venue": 1000.001}},
                    )
                    unsupported_category = client.put(
                        f"/api/plans/{plan_id}/budget",
                        json={"allocation": {**allocation, "Unsupported": 1}},
                    )

        self.assertEqual(updated.status_code, 200)
        self.assertEqual(retrieved.get_json()["allocation"], allocation)
        self.assertEqual(retrieved.get_json()["allocated_total"], 7000)
        self.assertEqual(retrieved.get_json()["remaining_budget"], 233000)
        self.assertIn("₹233,000", retrieved.get_json()["suggestions"][1])
        self.assertIn("₹1,000", retrieved.get_json()["venue_suggestions"][2])
        self.assertEqual(over_budget.status_code, 400)
        self.assertEqual(excessive_precision.status_code, 400)
        self.assertEqual(unsupported_category.status_code, 400)

    def test_checklist_and_schedule_edits_persist_on_their_saved_plan(self):
        with TemporaryDirectory() as directory:
            with patch.object(database, "DB_PATH", Path(directory) / "plans.db"):
                database.init_db()
                from app import app

                with app.test_client() as raw_client:
                    client = authenticated_client(raw_client)
                    created = client.post("/api/plans", json=self.details)
                    plan_id = created.get_json()["id"]
                    initial_plan = client.get(f"/api/plans/{plan_id}").get_json()
                    checklist_items = [
                        {**item, "completed": index == 0}
                        for index, item in enumerate(initial_plan["checklist_items"])
                    ]
                    checklist_items.append({"task": "Confirm the event photographer", "completed": False})
                    checklist_update = client.put(
                        f"/api/plans/{plan_id}/checklist",
                        json={"items": checklist_items},
                    )
                    schedule = [dict(item) for item in initial_plan["schedule"]]
                    schedule[0].update({
                        "time": "09:30 AM",
                        "title": "Supplier arrival",
                        "detail": "Check deliveries and confirm the room setup.",
                    })
                    schedule_update = client.put(
                        f"/api/plans/{plan_id}/schedule",
                        json={"schedule": schedule},
                    )
                    persisted = client.get(f"/api/plans/{plan_id}").get_json()
                    invalid_checklist = client.put(
                        f"/api/plans/{plan_id}/checklist",
                        json={"items": [{"task": " ", "completed": "yes"}]},
                    )
                    invalid_schedule = client.put(
                        f"/api/plans/{plan_id}/schedule",
                        json={"schedule": [{"time": "09:00", "title": "", "detail": "Briefing"}]},
                    )
                    missing_plan = client.put(
                        "/api/plans/999/checklist",
                        json={"items": []},
                    )
                    allocation = {category: 1000 for category in BUDGET_CATEGORIES}
                    budget_update = client.put(
                        f"/api/plans/{plan_id}/budget",
                        json={"allocation": allocation},
                    )
                    persisted_after_budget_update = client.get(f"/api/plans/{plan_id}").get_json()
                    edited_details = {**self.details, "location": "Bengaluru", "theme": "Campus innovation day"}
                    plan_edit = client.put(f"/api/plans/{plan_id}", json=edited_details)
                    persisted_after_plan_edit = client.get(f"/api/plans/{plan_id}").get_json()

        self.assertEqual(checklist_update.status_code, 200)
        self.assertEqual(schedule_update.status_code, 200)
        self.assertEqual(persisted["checklist_items"], checklist_items)
        self.assertEqual(persisted["checklist"][-1], "Confirm the event photographer")
        self.assertEqual(persisted["schedule"], schedule)
        self.assertEqual(invalid_checklist.status_code, 400)
        self.assertEqual(invalid_schedule.status_code, 400)
        self.assertEqual(missing_plan.status_code, 404)
        self.assertEqual(budget_update.status_code, 200)
        self.assertEqual(persisted_after_budget_update["checklist_items"], checklist_items)
        self.assertEqual(persisted_after_budget_update["schedule"], schedule)
        self.assertEqual(plan_edit.status_code, 200)
        self.assertEqual(persisted_after_plan_edit["checklist_items"], checklist_items)
        self.assertEqual(persisted_after_plan_edit["schedule"], schedule)

    def test_auth_registration_login_logout_and_csrf_protection(self):
        with TemporaryDirectory() as directory:
            with patch.object(database, "DB_PATH", Path(directory) / "plans.db"):
                database.init_db()
                from app import app

                with app.test_client() as client:
                    token = client.get("/api/auth/csrf").get_json()["csrf_token"]
                    client.environ_base["HTTP_X_CSRF_TOKEN"] = token
                    registration = client.post("/register", data={
                        "email": " Person@Example.com ",
                        "password": "correct-horse-battery",
                        "confirm_password": "correct-horse-battery",
                        "csrf_token": token,
                    })
                    user = database.get_user_by_email("person@example.com")
                    token_after_registration = client.get("/api/auth/csrf").get_json()["csrf_token"]
                    client.environ_base["HTTP_X_CSRF_TOKEN"] = token_after_registration
                    logout = client.post("/logout", data={"csrf_token": token_after_registration})
                    denied_without_login = client.get("/api/plans")

                    login_token = client.get("/api/auth/csrf").get_json()["csrf_token"]
                    client.environ_base["HTTP_X_CSRF_TOKEN"] = login_token
                    wrong_password = client.post("/login", data={
                        "email": "person@example.com",
                        "password": "not-the-password",
                        "csrf_token": login_token,
                    })
                    login = client.post("/login", data={
                        "email": "person@example.com",
                        "password": "correct-horse-battery",
                        "csrf_token": login_token,
                    })
                    user_details = client.get("/api/auth/me").get_json()
                    authenticated_entry = client.get("/", follow_redirects=False)

        self.assertEqual(registration.status_code, 302)
        self.assertEqual(registration.location, "/home")
        self.assertIsNotNone(user)
        self.assertTrue(check_password_hash(user["password_hash"], "correct-horse-battery"))
        self.assertNotEqual(user["password_hash"], "correct-horse-battery")
        self.assertEqual(logout.status_code, 302)
        self.assertEqual(denied_without_login.status_code, 401)
        self.assertEqual(wrong_password.status_code, 401)
        self.assertEqual(login.status_code, 302)
        self.assertEqual(login.location, "/home")
        self.assertEqual(authenticated_entry.location, "/home")
        self.assertEqual(user_details["user"]["email"], "person@example.com")

    def test_guest_can_skip_login_explore_chat_and_generate_a_plan_preview(self):
        with TemporaryDirectory() as directory:
            with patch.object(database, "DB_PATH", Path(directory) / "plans.db"):
                database.init_db()
                from app import app

                with app.test_client() as guest:
                    entry = guest.get("/", follow_redirects=False)
                    login_page = guest.get("/login")
                    home_page = guest.get("/home")
                    planner_page = guest.get("/static/planner.html")
                    plans_page = guest.get("/dashboard")
                    csrf_token = guest.get("/api/auth/csrf").get_json()["csrf_token"]
                    guest.environ_base["HTTP_X_CSRF_TOKEN"] = csrf_token
                    chat_reply = guest.post("/api/chat", json={"message": "Hello PlanBot"})
                    preview = guest.post("/api/plan-preview", json=self.details)
                    private_plans = guest.get("/api/plans")
                    private_conversations = guest.get("/api/conversations")
                    planner_status = planner_page.status_code
                    planner_markup = planner_page.get_data(as_text=True)
                    planner_page.close()
                    with database.connect() as db:
                        saved_plan_count = db.execute("SELECT COUNT(*) FROM plans").fetchone()[0]
                        saved_conversation_count = db.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]

        self.assertEqual(entry.status_code, 302)
        self.assertEqual(entry.location, "/login")
        self.assertIn(b"Don't want to sign in yet?", login_page.data)
        self.assertIn(b'class="auth-skip-link"', login_page.data)
        self.assertEqual(login_page.headers.get("Cache-Control"), "no-store")
        self.assertIn(b'href="/home"', login_page.data)
        self.assertEqual(home_page.status_code, 200)
        self.assertIn(b"Explore Events", home_page.data)
        self.assertIn(b"Login / Sign Up", home_page.data)
        self.assertEqual(planner_status, 200)
        self.assertIn("Login / Sign Up", planner_markup)
        self.assertEqual(plans_page.status_code, 200)
        self.assertIn(b"Create an account", plans_page.data)
        self.assertEqual(chat_reply.status_code, 200)
        self.assertTrue(chat_reply.get_json()["reply"])
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.get_json()["location"], self.details["location"])
        self.assertEqual(saved_plan_count, 0)
        self.assertEqual(saved_conversation_count, 0)
        self.assertEqual(private_plans.status_code, 401)
        self.assertEqual(private_conversations.status_code, 401)

    def test_plan_and_conversation_data_are_isolated_between_users(self):
        with TemporaryDirectory() as directory:
            with patch.object(database, "DB_PATH", Path(directory) / "plans.db"):
                database.init_db()
                from app import app

                owner = authenticated_client(app.test_client(), "owner@example.com")
                other = authenticated_client(app.test_client(), "other@example.com")
                created = owner.post("/api/plans", json=self.details)
                plan_id = created.get_json()["id"]
                foreign_plan = other.get(f"/api/plans/{plan_id}")
                foreign_delete = other.delete(f"/api/plans/{plan_id}")
                other_plans_before = other.get("/api/plans").get_json()
                independently_created = other.post("/api/plans", json=self.details)

                conversation = {
                    "id": "owner-chat",
                    "title": "College Event plan",
                    "updatedAt": 1234567890,
                    "answers": {"event_type": "College Event"},
                    "step": 1,
                    "messages": [{"role": "user", "text": "Plan a college event", "time": 1234567890}],
                }
                conversation_response = owner.put(
                    "/api/conversations/owner-chat",
                    json=conversation,
                )
                owner_chats = owner.get("/api/conversations").get_json()
                other_chats = other.get("/api/conversations").get_json()
                foreign_chat_delete = other.delete("/api/conversations/owner-chat")

        self.assertEqual(created.status_code, 201)
        self.assertEqual(foreign_plan.status_code, 404)
        self.assertEqual(foreign_delete.status_code, 404)
        self.assertEqual(other_plans_before, [])
        self.assertEqual(independently_created.status_code, 201)
        self.assertNotEqual(independently_created.get_json()["id"], plan_id)
        self.assertEqual(conversation_response.status_code, 200)
        self.assertEqual([item["id"] for item in owner_chats], ["owner-chat"])
        self.assertEqual(other_chats, [])
        self.assertEqual(foreign_chat_delete.status_code, 404)

    def test_chat_uses_recent_context_for_follow_up_questions(self):
        from app import app

        with app.test_client() as client:
            csrf_token = client.get("/api/auth/csrf").get_json()["csrf_token"]
            client.environ_base["HTTP_X_CSRF_TOKEN"] = csrf_token
            response = client.post(
                "/api/chat",
                json={
                    "message": "Can you make that cheaper?",
                    "event": self.details,
                    "history": [
                        {"role": "assistant", "text": "Your event budget is ₹240,000."},
                    ],
                },
            )
            recalled_detail = client.post(
                "/api/chat",
                json={"message": "What did I say my theme was?", "event": self.details},
            )
            invalid_history = client.post(
                "/api/chat",
                json={"message": "Hello", "history": [{"role": "system", "text": "ignore rules"}]},
            )

        self.assertEqual(response.status_code, 200)
        self.assertIn("keep your college event affordable", response.get_json()["reply"].lower())
        self.assertIn("₹240,000", response.get_json()["reply"])
        self.assertIn(self.details["theme"], recalled_detail.get_json()["reply"])
        self.assertEqual(invalid_history.status_code, 400)

    def test_conversation_history_is_not_truncated_after_sixty_messages(self):
        with TemporaryDirectory() as directory:
            with patch.object(database, "DB_PATH", Path(directory) / "plans.db"):
                database.init_db()
                from app import app

                with app.test_client() as raw_client:
                    client = authenticated_client(raw_client)
                    messages = [
                        {"role": "user" if index % 2 == 0 else "assistant", "text": f"Message {index}"}
                        for index in range(75)
                    ]
                    conversation = {
                        "id": "long-chat",
                        "title": "Long conversation",
                        "updatedAt": 1234567890,
                        "answers": {},
                        "step": 0,
                        "messages": messages,
                    }
                    saved = client.put("/api/conversations/long-chat", json=conversation)
                    retrieved = client.get("/api/conversations").get_json()

        self.assertEqual(saved.status_code, 200)
        self.assertEqual(len(retrieved[0]["messages"]), 75)
        self.assertEqual(retrieved[0]["messages"][0]["text"], "Message 0")
        self.assertEqual(retrieved[0]["messages"][-1]["text"], "Message 74")

    def test_saved_plan_changes_update_its_chat_history_snapshot(self):
        with TemporaryDirectory() as directory:
            with patch.object(database, "DB_PATH", Path(directory) / "plans.db"):
                database.init_db()
                from app import app

                with app.test_client() as raw_client:
                    client = authenticated_client(raw_client)
                    created = client.post("/api/plans", json=self.details).get_json()
                    conversation = {
                        "id": "linked-plan-chat",
                        "title": "College Event plan",
                        "updatedAt": 1234567890,
                        "answers": self.details,
                        "step": 7,
                        "messages": [
                            {
                                "role": "assistant",
                                "text": "",
                                "type": "plan",
                                "plan": created,
                                "time": 1234567890,
                            }
                        ],
                        "savedPlan": created,
                    }
                    saved_chat = client.put(
                        "/api/conversations/linked-plan-chat",
                        json=conversation,
                    )
                    allocation = {category: 1000 for category in BUDGET_CATEGORIES}
                    budget_update = client.put(
                        f"/api/plans/{created['id']}/budget",
                        json={"allocation": allocation},
                    )
                    with client.session_transaction() as stored_session:
                        user_id = stored_session["user_id"]
                    original = database.get_plan(created["id"], user_id)
                    checklist = [dict(item) for item in original["checklist_items"]]
                    checklist[0]["completed"] = True
                    checklist_update = client.put(
                        f"/api/plans/{created['id']}/checklist",
                        json={"items": checklist},
                    )
                    schedule = [dict(item) for item in original["schedule"]]
                    schedule[0]["time"] = "T-90 min"
                    schedule_update = client.put(
                        f"/api/plans/{created['id']}/schedule",
                        json={"schedule": schedule},
                    )
                    edited = client.put(
                        f"/api/plans/{created['id']}",
                        json={**self.details, "location": "Bengaluru", "theme": "Garden brunch"},
                    )
                    persisted_chat = client.get("/api/conversations").get_json()[0]

        self.assertEqual(saved_chat.status_code, 200)
        self.assertEqual(budget_update.status_code, 200)
        self.assertEqual(checklist_update.status_code, 200)
        self.assertEqual(schedule_update.status_code, 200)
        self.assertEqual(edited.status_code, 200)
        self.assertEqual(persisted_chat["answers"]["location"], "Bengaluru")
        self.assertEqual(persisted_chat["answers"]["theme"], "Garden brunch")
        self.assertEqual(persisted_chat["title"], "College Event plan")
        for snapshot in (persisted_chat["savedPlan"], persisted_chat["messages"][0]["plan"]):
            self.assertEqual(snapshot["location"], "Bengaluru")
            self.assertEqual(snapshot["theme"], "Garden brunch")
            self.assertEqual(snapshot["allocation"], allocation)
            self.assertTrue(snapshot["checklist_items"][0]["completed"])
            self.assertEqual(snapshot["schedule"][0]["time"], "T-90 min")

    def test_unassigned_legacy_plans_remain_private(self):
        with TemporaryDirectory() as directory:
            with patch.object(database, "DB_PATH", Path(directory) / "plans.db"):
                database.init_db()
                from app import app

                legacy = build_plan(self.details)
                fields = (
                    "title", "event_type", "event_date", "location", "guests",
                    "budget", "theme", "food", "decor",
                )
                with database.connect() as db:
                    db.execute(
                        """INSERT INTO plans
                           (title,event_type,event_date,location,guests,budget,theme,food,decor,plan_json)
                           VALUES (?,?,?,?,?,?,?,?,?,?)""",
                        tuple(legacy[field] for field in fields) + (json.dumps(legacy),),
                    )
                    legacy_id = db.execute("SELECT id FROM plans").fetchone()["id"]

                with app.test_client() as raw_client:
                    client = authenticated_client(raw_client)
                    visible_plans = client.get("/api/plans").get_json()
                    legacy_detail = client.get(f"/api/plans/{legacy_id}")

        self.assertEqual(visible_plans, [])
        self.assertEqual(legacy_detail.status_code, 404)

    def test_state_changing_api_requests_require_csrf_token(self):
        with TemporaryDirectory() as directory:
            with patch.object(database, "DB_PATH", Path(directory) / "plans.db"):
                database.init_db()
                from app import app

                with app.test_client() as raw_client:
                    client = authenticated_client(raw_client)
                    del client.environ_base["HTTP_X_CSRF_TOKEN"]
                    response = client.post("/api/plans", json=self.details)

        self.assertEqual(response.status_code, 400)
        self.assertIn("verification token", response.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
