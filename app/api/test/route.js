
import { NextResponse } from "next/server";
import { getAppAccessToken, getUser } from "@/lib/twitch";

export async function GET() {
  try {
    const token = await getAppAccessToken();

    const jesse = await getUser(
      process.env.JESSE_USERNAME,
      token
    );

    const julian = await getUser(
      process.env.JULIAN_USERNAME,
      token
    );

    return NextResponse.json({
      success: true,
      jesse: {
        id: jesse.id,
        username: jesse.login,
      },
      julian: {
        id: julian.id,
        username: julian.login,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
