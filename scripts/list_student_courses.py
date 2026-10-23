#!/usr/bin/env python3
"""Log into Qlicker and print the current student's courses."""

from __future__ import annotations

import argparse
import sys
from typing import Any

import requests


def normalize_api_base(base_url: str) -> str:
    base = base_url.strip().rstrip("/")
    if base.endswith("/api/v1"):
        return base
    if base.endswith("/api"):
        return f"{base}/v1"
    return f"{base}/api/v1"


def fail(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Login to Qlicker and print courses for a student user."
    )
    parser.add_argument(
        "--base-url",
        default="https://localhost",
        help="Qlicker app base URL (for example: https://qlicker.example.com).",
    )
    parser.add_argument("--email", required=True, help="Student email")
    parser.add_argument("--password", required=True, help="Student password")
    parser.add_argument(
        "--timeout",
        type=float,
        default=20.0,
        help="HTTP timeout in seconds (default: 20).",
    )
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="Disable TLS certificate verification (useful for self-signed certs).",
    )
    return parser.parse_args()


def format_course(course: dict[str, Any]) -> str:
    name = str(course.get("name") or "Unnamed course")
    dept = str(course.get("deptCode") or "").strip()
    number = str(course.get("courseNumber") or "").strip()
    section = str(course.get("section") or "").strip()
    semester = str(course.get("semester") or "").strip()
    course_id = str(course.get("_id") or "").strip()

    code_bits = [part for part in [dept, number] if part]
    code = " ".join(code_bits)
    if section:
        code = f"{code} ({section})" if code else section

    left = f"{code}: {name}" if code else name
    if semester:
        left = f"{left} [{semester}]"
    if course_id:
        left = f"{left} id={course_id}"
    return left


def main() -> None:
    args = parse_args()
    api_base = normalize_api_base(args.base_url)

    session = requests.Session()
    session.verify = not args.insecure
    session.headers.update({"X-Requested-With": "XMLHttpRequest"})

    login_response = session.post(
        f"{api_base}/auth/login",
        json={"email": args.email, "password": args.password},
        timeout=args.timeout,
    )
    if login_response.status_code != 200:
        fail(
            f"Login failed ({login_response.status_code}): {login_response.text}",
            code=2,
        )

    login_body = login_response.json()
    token = login_body.get("token")
    if not token:
        fail("Login succeeded but no access token was returned.", code=2)

    session.headers["Authorization"] = f"Bearer {token}"

    courses: list[dict[str, Any]] = []
    page = 1
    limit = 500

    while True:
        response = session.get(
            f"{api_base}/courses",
            params={"view": "student", "page": page, "limit": limit},
            timeout=args.timeout,
        )
        if response.status_code != 200:
            fail(
                f"Failed to fetch courses ({response.status_code}): {response.text}",
                code=3,
            )

        body = response.json()
        page_courses = body.get("courses") or []
        if isinstance(page_courses, list):
            courses.extend(page_courses)

        total_pages = int(body.get("pages") or 0)
        if total_pages <= 0 or page >= total_pages:
            break
        page += 1

    if not courses:
        print("No active student courses found.")
        return

    print(f"Found {len(courses)} course(s):")
    for course in courses:
        print(f"- {format_course(course)}")


if __name__ == "__main__":
    main()
