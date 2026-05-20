"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { clsx } from "clsx";

interface RazorpayHandlerResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: (response: RazorpayHandlerResponse) => void | Promise<void>;
  prefill?: { email?: string; name?: string };
  theme?: { color?: string };
  modal?: { ondismiss?: () => void };
}

interface RazorpayInstance {
  open: () => void;
  on: (event: string, handler: () => void) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

const CHECKOUT_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";

let scriptPromise: Promise<void> | null = null;

function loadRazorpayScript(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Razorpay runs in the browser only"));
  }
  if (window.Razorpay) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${CHECKOUT_SCRIPT}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error("Failed to load Razorpay")),
      );
      return;
    }
    const script = document.createElement("script");
    script.src = CHECKOUT_SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Razorpay"));
    document.body.appendChild(script);
  });

  return scriptPromise;
}

interface PricingCheckoutButtonProps {
  tier?: "pro";
  label?: string;
  className?: string;
}

export function PricingCheckoutButton({
  tier = "pro",
  label = "Choose Pro",
  className,
}: PricingCheckoutButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCheckout = useCallback(async () => {
    setError(null);
    setLoading(true);

    try {
      await loadRazorpayScript();
      if (!window.Razorpay) {
        throw new Error("Razorpay checkout failed to initialize");
      }

      const res = await fetch("/api/payments/razorpay/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });

      const data = (await res.json()) as {
        error?: string;
        orderId?: string;
        amount?: number;
        currency?: string;
        keyId?: string;
      };

      if (!res.ok) {
        throw new Error(data.error ?? "Could not start checkout");
      }

      if (!data.orderId || !data.keyId || data.amount == null || !data.currency) {
        throw new Error("Invalid order response from server");
      }

      const rzp = new window.Razorpay({
        key: data.keyId,
        amount: data.amount,
        currency: data.currency,
        name: "Night PR Reviewer",
        description: "Pro plan — monthly",
        order_id: data.orderId,
        theme: { color: "#000000" },
        handler: async (response) => {
          setLoading(true);
          try {
            const verifyRes = await fetch("/api/payments/razorpay/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...response,
                tier,
              }),
            });
            const verifyData = (await verifyRes.json()) as { error?: string };
            if (!verifyRes.ok) {
              throw new Error(verifyData.error ?? "Payment verification failed");
            }
            router.push("/login?paid=1");
          } catch (e) {
            setError(e instanceof Error ? e.message : "Verification failed");
          } finally {
            setLoading(false);
          }
        },
        modal: {
          ondismiss: () => setLoading(false),
        },
      });

      setLoading(false);
      rzp.open();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checkout failed");
      setLoading(false);
    }
  }, [router, tier]);

  return (
    <div className="w-full">
      <Button
        type="button"
        variant="default"
        size="lg"
        disabled={loading}
        onClick={handleCheckout}
        className={clsx(
          "w-full !bg-black !text-white !border-black hover:!bg-black/90",
          className,
        )}
      >
        {loading ? "Opening checkout…" : label}
      </Button>
      {error && (
        <p className="mt-2 text-[10px] font-mono text-[#ff5a5a] text-center">
          {error}
        </p>
      )}
    </div>
  );
}
