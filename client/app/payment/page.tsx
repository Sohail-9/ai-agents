'use client';

import { useEffect, useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useAuth } from "@/lib/auth-client";
import { CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

function PaymentContent() {
  const { getToken } = useAuth();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const success = searchParams.get('success') === 'true';
  const transactionId = searchParams.get('transactionId');

  const handleSuccess = async () => {
    if (!transactionId) {
      setError('Missing transaction ID');
      setLoading(false);
      return;
    }

    try {
      const token = await getToken();
      const response = await fetch(`${BACKEND_URL}/api/payments/update-by-transaction`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          transactionId,
          success: true,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('❌ Payment update failed:', data);
        setError(data.error || 'Failed to update payment');
      } else {
        console.log('✅ Payment success:', data);
        console.log('Status:', data.status);
        console.log('Credits updated for plan:', data.planId);
      }
    } catch (err: any) {
      console.error('Payment success update failed:', err);
      setError(err?.message || 'An error occurred while processing your payment');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!transactionId) {
      setError('Missing transaction ID');
      setLoading(false);
      return;
    }

    try {
      const token = await getToken();
      const response = await fetch(`${BACKEND_URL}/api/payments/update-by-transaction`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          transactionId,
          success: false,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        setError(data.error || 'Failed to cancel payment');
      }
      console.log('❌ Payment cancelled:', transactionId);
    } catch (err: any) {
      console.error('Payment cancel update failed:', err);
      setError(err?.message || 'An error occurred while processing your request');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (success) {
      handleSuccess();
    } else {
      handleCancel();
    }
  }, [transactionId, success]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="text-center">
          <Loader2 className="h-12 w-12 animate-spin text-gray-400 mx-auto mb-4" />
          <p className="text-gray-600">Processing your payment...</p>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="max-w-2xl w-full bg-white rounded-3xl shadow-lg p-8 md:p-12 text-center">
          <div className="flex justify-center mb-6">
            <div className="h-24 w-24 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle2 className="h-14 w-14 text-green-600" />
            </div>
          </div>

          <h1 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4">
            Your Payment is Successful
          </h1>

          <p className="text-gray-600 text-lg mb-8">
            Thank you for your payment. An automated payment receipt will be sent
            to your registered email address shortly.
          </p>

          <div className="bg-green-50 border border-green-200 rounded-2xl p-5 mb-8">
            <p className="text-green-700 font-medium">
              Payment has been processed successfully.
            </p>
            {transactionId && (
              <p className="text-green-600 text-sm mt-2">
                Transaction ID: {transactionId}
              </p>
            )}
          </div>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/"
              className="px-6 py-3 rounded-xl bg-black text-white font-medium hover:bg-gray-800 transition"
            >
              Go to Dashboard
            </Link>

            <Link
              href="/pricing"
              className="px-6 py-3 rounded-xl border border-gray-300 text-gray-700 font-medium hover:bg-gray-100 transition"
            >
              View Plans
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-2xl w-full bg-white rounded-3xl shadow-lg p-8 md:p-12 text-center">
        <div className="flex justify-center mb-6">
          <div className="h-24 w-24 rounded-full bg-red-100 flex items-center justify-center">
            <AlertCircle className="h-14 w-14 text-red-600" />
          </div>
        </div>

        <h1 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4">
          Payment Failed
        </h1>

        <p className="text-gray-600 text-lg mb-8">
          Unfortunately, your payment could not be processed. Please check your
          payment details and try again.
        </p>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-5 mb-8">
            <p className="text-red-700 text-sm">{error}</p>
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/pricing"
            className="px-6 py-3 rounded-xl bg-black text-white font-medium hover:bg-gray-800 transition"
          >
            Try Again
          </Link>

          <Link
            href="/"
            className="px-6 py-3 rounded-xl border border-gray-300 text-gray-700 font-medium hover:bg-gray-100 transition"
          >
            Go to Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function PaymentPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin" /></div>}>
      <PaymentContent />
    </Suspense>
  );
}
